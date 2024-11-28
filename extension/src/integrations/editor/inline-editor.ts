import * as vscode from "vscode"
import PQueue from "p-queue"

/**
 * Represents a block of text that is being edited inline
 * @property id - Unique identifier for the edit block
 * @property searchContent - Original content to search for in the document
 * @property currentContent - Current content being shown (may be streaming)
 * @property finalContent - Final content after streaming is complete
 * @property status - Current state of the edit block (pending/streaming/final)
 */
interface EditBlock {
	id: string
	searchContent: string
	currentContent: string
	finalContent?: string
	status: "pending" | "streaming" | "final"
}

/**
 * Maintains the state of a document being edited
 * @property uri - VSCode URI of the document
 * @property originalContent - Original content when editing started
 * @property currentContent - Current content with all edits applied
 * @property editBlocks - Map of edit blocks being processed
 */
interface DocumentState {
	uri: vscode.Uri
	originalContent: string
	currentContent: string
	editBlocks: Map<string, EditBlock>
}

/**
 * Represents an operation that is waiting to be applied
 * Used when operations arrive before the editor is ready
 * @property type - Type of operation (stream/final)
 * @property id - ID of the edit block
 * @property searchContent - Content to search for
 * @property content - Content to apply
 * @property timestamp - When the operation was queued
 */
interface PendingOperation {
	type: "stream" | "final"
	id: string
	searchContent: string
	content: string
	timestamp: number
}

/**
 * Handles inline editing functionality in VSCode text editors
 * Provides real-time updates, decorations, and manages edit state
 *
 * Key features:
 * - Supports streaming updates with visual indicators
 * - Maintains document state and edit history
 * - Handles queuing and sequential processing of edits
 * - Provides visual decorations for different edit states
 * - Supports auto-scrolling to edited regions
 */
export class InlineEditHandler {
	// Decorations for different edit states
	private pendingDecoration: vscode.TextEditorDecorationType
	private streamingDecoration: vscode.TextEditorDecorationType
	private mergeDecoration: vscode.TextEditorDecorationType

	// Controls auto-scroll behavior
	private isAutoScrollEnabled: boolean = true

	// Maintains current document state
	protected currentDocumentState: DocumentState | undefined

	// Queue for processing operations sequentially
	private operationQueue: PQueue

	// Holds operations that arrive before editor is ready
	private pendingOperations: PendingOperation[] = []

	constructor() {
		// Initialize PQueue with concurrency 1 to ensure sequential operations
		this.operationQueue = new PQueue({ concurrency: 1 })
		this.pendingDecoration = this.createDecoration("⟳ Pending changes", "editorGhostText.foreground")
		this.streamingDecoration = this.createDecoration("↻ Streaming changes...", "editorInfo.foreground")
		this.mergeDecoration = this.createDecoration("⚡ Review changes", "editorInfo.foreground")

		this.logger("InlineEditHandler initialized", "debug")
	}

	private createDecoration(text: string, color: string): vscode.TextEditorDecorationType {
		return vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
			after: {
				margin: "0 0 0 1em",
				contentText: text,
				color: new vscode.ThemeColor(color),
			},
			before: {
				margin: "0 0 0 1em",
			},
			light: {
				backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
				before: {
					color: new vscode.ThemeColor("editor.foreground"),
				},
			},
			dark: {
				backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
				before: {
					color: new vscode.ThemeColor("editor.foreground"),
				},
			},
		})
	}

	/**
	 * Scrolls the editor to show the edited range with context
	 * Adds a temporary highlight effect to draw attention
	 *
	 * @param editor - The VSCode text editor to scroll
	 * @param range - The range to scroll to and highlight
	 *
	 * Features:
	 * - Centers the edit in view
	 * - Shows context lines above/below
	 * - Adds temporary highlight animation
	 * - Respects auto-scroll setting
	 */
	private async scrollToRange(editor: vscode.TextEditor, range: vscode.Range) {
		if (!this.isAutoScrollEnabled) {
			return
		}

		try {
			const visibleRanges = editor.visibleRanges
			if (visibleRanges.length === 0) {
				return
			}

			// Calculate visible range size
			const visibleLines = visibleRanges[0].end.line - visibleRanges[0].start.line

			// Position the edited range in the center-bottom of the viewport
			// Try to show a few lines of context above the edit
			const contextLines = Math.min(10, Math.floor(visibleLines * 0.3))
			const targetLine = Math.max(0, range.end.line - Math.floor(visibleLines * 0.7))

			// Create a range that includes context
			const revealRange = new vscode.Range(
				new vscode.Position(targetLine, 0),
				new vscode.Position(range.end.line + contextLines, range.end.character)
			)

			// Reveal with smooth scrolling
			await editor.revealRange(revealRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport)

			// Add a temporary highlight effect
			const highlightDecoration = vscode.window.createTextEditorDecorationType({
				backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
				borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
				borderWidth: "1px",
				borderStyle: "solid",
				isWholeLine: true,
			})

			editor.setDecorations(highlightDecoration, [range])

			// Remove highlight after a short delay
			setTimeout(() => highlightDecoration.dispose(), 800)
		} catch (error) {
			this.logger(`Failed to scroll to range: ${error}`, "error")
		}
	}

	/**
	 * Opens a file for editing and initializes the document state
	 * Processes any pending operations that arrived before opening
	 *
	 * @param id - Unique identifier for this edit session
	 * @param filePath - Path to the file to edit
	 * @param searchContent - Initial content to search for
	 *
	 * Steps:
	 * 1. Reads file content
	 * 2. Shows document in editor
	 * 3. Initializes document state
	 * 4. Processes pending operations
	 * 5. Applies initial decorations
	 */
	public async open(id: string, filePath: string, searchContent: string): Promise<void> {
		this.logger(`Opening file ${filePath} with id ${id}`, "debug")
		return this.operationQueue.add(
			async () => {
				try {
					if (this.currentDocumentState) {
						this.logger(`Document already open, no need to open again`, "debug")
						return
					}
					const uri = vscode.Uri.file(filePath)
					const documentBuffer = await vscode.workspace.fs.readFile(uri)
					const documentContent = Buffer.from(documentBuffer).toString("utf8")

					// now let's make it focused and active
					await vscode.window.showTextDocument(uri, {
						viewColumn: vscode.ViewColumn.Active,
						preserveFocus: false,
						preview: false,
					})

					// Initialize or reset document state
					this.currentDocumentState = {
						uri: uri,
						originalContent: documentContent,
						currentContent: documentContent,
						editBlocks: new Map(),
					}

					// Add initial block
					this.currentDocumentState.editBlocks.set(id, {
						id,
						searchContent,
						currentContent: searchContent,
						status: "pending",
					})

					// Process any pending operations that accumulated before opening
					if (this.pendingOperations.length > 0) {
						this.logger(`Processing ${this.pendingOperations.length} pending operations`, "debug")
						const operations = [...this.pendingOperations]
						this.pendingOperations = []

						for (const op of operations) {
							this.logger(`Processing pending operation: ${op.type} for id ${op.id}`, "debug")
							if (op.type === "stream") {
								await this.applyStreamContent(op.id, op.searchContent, op.content)
							} else {
								await this.applyFinalContent(op.id, op.searchContent, op.content)
							}
						}
					}

					// Apply decorations
					await this.refreshEditor()
					this.logger(`Successfully opened file ${filePath}`, "debug")
					return
				} catch (error) {
					this.logger(`Failed to open document: ${error}`, "error")
					throw error
				}
			},
			{
				// highest
				priority: 10,
			}
		)
	}

	/**
	 * Applies streaming content updates to an edit block
	 * Used for real-time updates while content is being generated
	 *
	 * @param id - Unique identifier for the edit block
	 * @param searchContent - Content to search for in the document
	 * @param content - New content to apply (streaming)
	 *
	 * Features:
	 * - Queues operations if editor isn't ready
	 * - Creates new block if none exists
	 * - Updates block status to "streaming"
	 * - Triggers visual updates
	 */
	public async applyStreamContent(id: string, searchContent: string, content: string): Promise<void> {
		this.logger(`Applying stream content for id ${id}`, "debug")

		// If editor isn't open, queue the operation
		if (!this.isOpen()) {
			this.logger(`Editor not open, queueing stream operation for id ${id}`, "debug")
			this.pendingOperations.push({
				type: "stream",
				id,
				searchContent,
				content,
				timestamp: Date.now(),
			})
			return
		}

		return this.operationQueue.add(async () => {
			try {
				this.validateDocumentState()
				let block = this.currentDocumentState.editBlocks.get(id)
				if (!block) {
					block = {
						id,
						searchContent,
						currentContent: searchContent,
						status: "pending",
					}
					this.currentDocumentState.editBlocks.set(id, block)
				}

				// Update block content
				block.currentContent = content
				block.status = "streaming"

				this.logger(`Applying streaming content for id ${id}`, "info")
				this.logger(`searchContent length: ${searchContent.length}`, "info")
				this.logger(`replaceContent length: ${content.length}`, "info")
				// Update entire file content
				await this.updateFileContent()
				return
			} catch (error) {
				this.logger(`Failed to apply streaming content: ${error}`, "error")
				throw error
			}
		})
	}

	/**
	 * Applies final content to an edit block
	 * Used when content generation is complete
	 *
	 * @param id - Unique identifier for the edit block
	 * @param searchContent - Content to search for in the document
	 * @param content - Final content to apply
	 *
	 * Features:
	 * - Queues operations if editor isn't ready
	 * - Creates new block if none exists
	 * - Updates block status to "final"
	 * - Stores final content for future reference
	 */
	public async applyFinalContent(id: string, searchContent: string, content: string): Promise<void> {
		this.logger(`Applying final content for id ${id}`, "debug")

		// If editor isn't open, queue the operation
		if (!this.isOpen()) {
			this.logger(`Editor not open, queueing final operation for id ${id}`, "debug")
			this.pendingOperations.push({
				type: "final",
				id,
				searchContent,
				content,
				timestamp: Date.now(),
			})
			return
		}

		return this.operationQueue.add(async () => {
			try {
				this.validateDocumentState()
				let block = this.currentDocumentState.editBlocks.get(id)
				if (!block) {
					block = {
						id,
						searchContent,
						currentContent: searchContent,
						status: "pending",
					}
					this.currentDocumentState.editBlocks.set(id, block)
				}

				// Update block content
				block.currentContent = content
				block.finalContent = content
				block.status = "final"

				// Update entire file content
				await this.updateFileContent()
				return
			} catch (error) {
				this.logger(`Failed to apply final content: ${error}`, "error")
				throw error
			}
		})
	}

	/**
	 * Updates the entire file content with all edit blocks
	 * Maintains order of edits and applies them sequentially
	 *
	 * Process:
	 * 1. Starts with original document content
	 * 2. Sorts blocks by their position in the document
	 * 3. Applies each block's changes in order
	 * 4. Updates the entire document at once
	 * 5. Refreshes editor decorations
	 *
	 * Note: Uses workspace edit API to ensure proper undo/redo support
	 */
	private async updateFileContent(): Promise<void> { 
		this.validateDocumentState(); 
	 
		try { 
			const document = await this.getDocument(); 
			if (!document) { 
				throw new Error("No active document to update content."); 
			} 
	 
			let newContent = this.currentDocumentState.originalContent; 
			this.logger(`Original content length: ${newContent.length}`, "debug"); 
	 
			const contentChunks = newContent.match(/.{1,1000}/g) || []; 
			this.logger(`Original content in chunks:`, "debug"); 
			contentChunks.forEach((chunk, i) => { 
				this.logger(`Chunk ${i}:\n${chunk}`, "debug"); 
			}); 
	 
			const normalize = (str: string) => 
				str.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, ""); 
			let normalizedContent = normalize(newContent); 
	 
			const sortedBlocks = Array.from( 
				this.currentDocumentState.editBlocks.values() 
			).sort((a, b) => { 
				if (!this.currentDocumentState.originalContent) { 
					return 0; 
				} 
				const indexA = normalizedContent.indexOf(normalize(a.searchContent)); 
				const indexB = normalizedContent.indexOf(normalize(b.searchContent)); 
				if (indexA === -1) return 1; 
				if (indexB === -1) return -1; 
				return indexA - indexB; 
			}); 
	 
			this.logger(`Processing ${sortedBlocks.length} edit blocks`, "debug"); 
	 
			for (const block of sortedBlocks) { 
				this.logger(`Processing block ${block.id}:`, "debug"); 
				this.logger( 
					`Search content length: ${block.searchContent.length}`, 
					"debug" 
				); 
				this.logger( 
					`Replace content length: ${block.currentContent.length}`, 
					"debug" 
				); 
				this.logger( 
					`Search content first line: ${block.searchContent.split("\n")[0]}`, 
					"debug" 
				); 
				this.logger( 
					`Replace content first line: ${block.currentContent.split("\n")[0]}`, 
					"debug" 
				); 
	 
				const normalizedSearch = normalize(block.searchContent); 
				const normalizedReplace = normalize(block.currentContent); 
	 
				const beforeContent = normalizedContent; 
				normalizedContent = normalizedContent.replace( 
					normalizedSearch, 
					normalizedReplace 
				); 
	 
				if ( 
					normalizedContent === beforeContent && 
					normalizedSearch !== normalizedReplace 
				) { 
					this.logger(`Failed to apply block: ${block.id}`, "error"); 
					this.logger(`Search content not found in file`, "error"); 
					this.logger( 
						`Differences:\n${this.generateDiff( 
							normalizedSearch, 
							beforeContent 
						)}`, 
						"debug" 
					); 
					throw new Error(`Failed to apply edit block: ${block.id}`); 
				} else { 
					this.logger(`Successfully applied block ${block.id}`, "debug"); 
				} 
			} 
	 
			const entireRange = new vscode.Range( 
				document.positionAt(0), 
				document.positionAt(document.getText().length) 
			); 
	 
			const workspaceEdit = new vscode.WorkspaceEdit(); 
			workspaceEdit.replace(document.uri, entireRange, normalizedContent); 
			const success = await vscode.workspace.applyEdit(workspaceEdit); 
	 
			if (success) { 
				this.logger("File content updated", "info"); 
				this.currentDocumentState.currentContent = normalizedContent; 
				await this.refreshEditor(); 
			} else { 
				this.logger("Failed to apply edit blocks", "error"); 
				throw new Error("Failed to apply edit blocks"); 
			} 
	 
			return; 
		} catch (error) { 
			this.logger(`Failed to update file content: ${error}`, "error"); 
			throw error; 
		} 
	} 
	 
	private generateDiff(original: string, updated: string): string { 
		const originalLines = original.split("\n"); 
		const updatedLines = updated.split("\n"); 
		const differences = originalLines.map((line, index) => { 
			if (line !== updatedLines[index]) { 
				return `Line ${index + 1}:\nOriginal: ${line}\nUpdated: ${ 
					updatedLines[index] || "[MISSING]" 
				}`; 
			} 
			return null; 
		}); 
		return differences.filter((diff) => diff).join("\n"); 
	}

	/**
	 * Refreshes the editor's visual state
	 * Updates decorations and scrolling for all edit blocks
	 *
	 * Process:
	 * 1. Clears existing decorations
	 * 2. Groups ranges by edit status
	 * 3. Applies new decorations for each status
	 * 4. Handles auto-scrolling to active edits
	 *
	 * Decorations:
	 * - Pending: Awaiting changes
	 * - Streaming: Currently receiving updates
	 * - Merge: Ready for review
	 */
	private async refreshEditor(): Promise<void> {
		this.validateDocumentState()

		const document = await this.getDocument()
		if (!document) {
			throw new Error("No active document to refresh editor.")
		}

		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.toString() === document.uri.toString()
		)

		if (editor) {
			// Clear existing decorations
			editor.setDecorations(this.pendingDecoration, [])
			editor.setDecorations(this.streamingDecoration, [])
			editor.setDecorations(this.mergeDecoration, [])

			// Group ranges by status
			const pendingRanges: vscode.Range[] = []
			const streamingRanges: vscode.Range[] = []
			const mergeRanges: vscode.Range[] = []

			// Apply new decorations based on block status
			for (const block of this.currentDocumentState.editBlocks.values()) {
				const searchIndex = document.getText().indexOf(block.currentContent)
				if (searchIndex !== -1) {
					const range = new vscode.Range(
						document.positionAt(searchIndex),
						document.positionAt(searchIndex + block.currentContent.length)
					)

					switch (block.status) {
						case "pending":
							pendingRanges.push(range)
							break
						case "streaming":
							streamingRanges.push(range)
							break
						case "final":
							mergeRanges.push(range)
							break
					}

					// Only scroll to streaming or final changes
					if ((block.status === "streaming" || block.status === "final") && this.isAutoScrollEnabled) {
						await this.scrollToRange(editor, range)
					}
				}
			}

			// Apply all decorations at once for better performance
			if (pendingRanges.length > 0) {
				editor.setDecorations(this.pendingDecoration, pendingRanges)
			}
			if (streamingRanges.length > 0) {
				editor.setDecorations(this.streamingDecoration, streamingRanges)
			}
			if (mergeRanges.length > 0) {
				editor.setDecorations(this.mergeDecoration, mergeRanges)
			}
		}
	}

	/**
	 * Forces all edit blocks to their final state
	 * Used when streaming needs to be completed immediately
	 *
	 * @param diffBlocks - Array of blocks with their final content
	 *
	 * Process:
	 * 1. Shows document in active editor
	 * 2. Updates all blocks to final state
	 * 3. Applies changes to document
	 * 4. Updates decorations
	 *
	 * Note: This is typically used when streaming needs to be
	 * terminated early or when applying multiple changes at once
	 */
	public async forceFinalizeAll(
		diffBlocks: { id: string; searchContent: string; replaceContent: string }[]
	): Promise<void> {
		this.logger("Forcing finalization of all blocks", "debug")
		return this.operationQueue.add(async () => {
			this.validateDocumentState()
			// let's open the document and make it focused and active
			await vscode.window.showTextDocument(this.currentDocumentState.uri, {
				viewColumn: vscode.ViewColumn.Active,
				preserveFocus: false,
				preview: false,
			})

			try {
				// Update all blocks to final state
				for (const block of diffBlocks) {
					const existingBlock = this.currentDocumentState.editBlocks.get(block.id)
					if (existingBlock) {
						existingBlock.currentContent = block.replaceContent
						existingBlock.finalContent = block.replaceContent
						existingBlock.status = "final"
					} else {
						this.currentDocumentState.editBlocks.set(block.id, {
							id: block.id,
							searchContent: block.searchContent,
							currentContent: block.replaceContent,
							finalContent: block.replaceContent,
							status: "final",
						})
					}
				}

				// Update entire file content
				return await this.updateFileContent()
			} catch (error) {
				this.logger(`Failed to finalize all blocks: ${error}`, "error")
				throw error
			}
		})
	}

	/**
	 * Retrieves or opens the document being edited
	 * Ensures we have a valid document reference
	 *
	 * Process:
	 * 1. Checks for existing document in workspace
	 * 2. Opens document if not found or closed
	 * 3. Returns undefined if document cannot be accessed
	 *
	 * Note: This is a helper method used by other operations
	 * that need to access or modify the document
	 */
	private async getDocument(): Promise<vscode.TextDocument | undefined> {
		this.validateDocumentState()
		try {
			const { uri } = this.currentDocumentState
			let document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString())
			if (!document || !document.isClosed) {
				document = await vscode.workspace.openTextDocument(uri)
			}
			return document
		} catch (error) {
			this.logger(`Failed to get document: ${error}`, "error")
			return undefined
		}
	}

	/**
	 * Saves all changes to the document
	 * Preserves any user modifications made after our edits
	 *
	 * Process:
	 * 1. Validates document state
	 * 2. Saves current document content
	 * 3. Returns final content including any user changes
	 * 4. Cleans up resources after saving
	 *
	 * Note: This is typically called when all edits are complete
	 * and changes need to be persisted to disk
	 */
	public async saveChanges(): Promise<string> {
		this.logger("Saving changes", "debug")
		const res = await this.operationQueue.add(async () => {
			this.validateDocumentState()

			try {
				const document = await this.getDocument()
				if (!document || document.isClosed) {
					throw new Error("No active document to save changes.")
				}

				// We don't want to override any user changes made after our last edit
				// So we'll just save whatever is currently in the document
				const res = await document.save()
				this.logger(`save reuslt: ${res}`, "info")
				// Get the current content which might include user changes
				const finalContent = document.getText()

				// Clean up
				setTimeout(() => {
					this.dispose()
				}, 1)

				return finalContent
			} catch (error) {
				this.logger(`Failed to save changes: ${error}`, "error")
				throw error
			}
		})
		if (res) {
			this.logger("Changes saved", "debug")
			return res
		}
		this.logger("Failed to save changes", "error")
		this.logger(`Total pending operations: ${this.pendingOperations.length}`, "error")

		throw new Error("Failed to save changes")
	}

	/**
	 * Rejects all changes and restores original content
	 * Used when edits need to be discarded
	 *
	 * Process:
	 * 1. Validates document state
	 * 2. Restores original content from when file was opened
	 * 3. Saves the restored content
	 * 4. Cleans up resources
	 *
	 * Note: This completely discards all changes and cannot be undone
	 */
	public async rejectChanges(): Promise<void> {
		this.logger("Rejecting changes", "debug")
		return this.operationQueue.add(async () => {
			this.validateDocumentState()

			try {
				const document = await this.getDocument()
				if (!document) {
					throw new Error("No active document to reject changes.")
				}

				// Always restore to the original content from when we first opened the file
				const workspaceEdit = new vscode.WorkspaceEdit()
				workspaceEdit.replace(
					document.uri,
					new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
					this.currentDocumentState.originalContent
				)

				const success = await vscode.workspace.applyEdit(workspaceEdit)
				if (success) {
					// Make sure to save after rejecting
					await document.save()

					// Clean up
					this.dispose()
				} else {
					this.logger("Failed to reject changes: workspaceEdit.applyEdit returned false", "error")
					throw new Error("Failed to reject changes: workspaceEdit.applyEdit returned false")
				}
			} catch (error) {
				this.logger(`Failed to reject changes: ${error}`, "error")
				throw error
			}
		})
	}

	public isOpen(): boolean {
		const isOpen = !!this.currentDocumentState
		return isOpen
	}

	public setAutoScroll(enabled: boolean) {
		this.isAutoScrollEnabled = enabled
		this.logger(`Auto-scroll ${enabled ? "enabled" : "disabled"}`)
	}

	public dispose() {
		this.logger("Disposing InlineEditHandler")
		this.pendingDecoration.dispose()
		this.streamingDecoration.dispose()
		this.mergeDecoration.dispose()

		// Force garbage collection of any remaining decorations
		if (vscode.window.activeTextEditor) {
			this.pendingDecoration.dispose()
			this.streamingDecoration.dispose()
			this.mergeDecoration.dispose()
		}

		// Clear any pending operations
		this.pendingOperations = []

		// Clear the operation queue
		this.operationQueue.clear()
	}

	// type guard against this.currentDocumentState being undefined
	/**
	 * Type guard to ensure document state exists
	 * Throws error if state is undefined
	 *
	 * This is used by methods that require access to document state
	 * to ensure type safety and prevent undefined errors
	 */
	private validateDocumentState(): asserts this is { currentDocumentState: DocumentState } {
		if (!this.currentDocumentState) {
			this.logger("No active document state", "error")
			throw new Error("No active document state.")
		}
	}

	/**
	 * Logs messages with contextual information
	 * Includes operation queue size, pending operations count,
	 * and editor state for better debugging
	 *
	 * @param message - The message to log
	 * @param level - Log level (info/debug/warn/error)
	 */
	private logger(message: string, level: "info" | "debug" | "warn" | "error" = "debug") {
		const timestamp = new Date().toISOString()
		const queueSize = this.operationQueue ? this.operationQueue.size : 0
		const pendingOps = this.pendingOperations.length
		const isEditorOpen = this.isOpen()

		console[level](
			`[InlineEditHandler] ${timestamp} | ` +
				`Queue: ${queueSize} | Pending: ${pendingOps} | Editor: ${isEditorOpen ? "open" : "closed"} | ` +
				message
		)
	}
}
