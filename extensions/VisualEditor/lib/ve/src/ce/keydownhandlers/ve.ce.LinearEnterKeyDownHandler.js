/*!
 * VisualEditor ContentEditable linear enter key down handler
 *
 * @copyright 2011-2016 VisualEditor Team and others; see http://ve.mit-license.org
 */

/**
 * Enter key down handler for linear selections.
 *
 * @class
 * @extends ve.ce.KeyDownHandler
 *
 * @constructor
 */
ve.ce.LinearEnterKeyDownHandler = function VeCeLinearEnterKeyDownHandler() {
	// Parent constructor
	ve.ui.LinearEnterKeyDownHandler.super.apply( this, arguments );
};

/* Inheritance */

OO.inheritClass( ve.ce.LinearEnterKeyDownHandler, ve.ce.KeyDownHandler );

/* Static properties */

ve.ce.LinearEnterKeyDownHandler.static.name = 'linearEnter';

ve.ce.LinearEnterKeyDownHandler.static.keys = [ OO.ui.Keys.ENTER ];

ve.ce.LinearEnterKeyDownHandler.static.supportedSelections = [ 'linear' ];

/* Static methods */

/**
 * @inheritdoc
 */
ve.ce.LinearEnterKeyDownHandler.static.execute = function ( surface, e ) {
	var txRemove, txInsert, outerParent, outerChildrenCount, list, prevContentOffset,
		insertEmptyParagraph, node, focusedNode,
		range = surface.model.getSelection().getRange(),
		cursor = range.from,
		documentModel = surface.model.getDocument(),
		emptyParagraph = [ { type: 'paragraph' }, { type: '/paragraph' } ],
		advanceCursor = true,
		stack = [],
		outermostNode = null,
		nodeModel = null,
		nodeModelRange = null;

	e.preventDefault();

	focusedNode = surface.getFocusedNode();
	if ( focusedNode ) {
		focusedNode.executeCommand();
		return true;
	}

	// Handle removal first
	if ( !range.isCollapsed() ) {
		txRemove = ve.dm.Transaction.newFromRemoval( documentModel, range );
		range = txRemove.translateRange( range );
		// We do want this to propagate to the surface
		surface.model.change( txRemove, new ve.dm.LinearSelection( documentModel, range ) );
	}

	node = surface.documentView.getBranchNodeFromOffset( range.from );
	if ( node !== null ) {
		// assertion: node is certainly a contentBranchNode
		nodeModel = node.getModel();
		nodeModelRange = nodeModel.getRange();
	}

	// Handle insertion
	if ( node === null ) {
		throw new Error( 'node === null' );
	} else if (
		nodeModel.getType() !== 'paragraph' &&
		(
			cursor === nodeModelRange.from ||
			cursor === nodeModelRange.to
		)
	) {
		// If we're at the start/end of something that's not a paragraph, insert a paragraph
		// before/after. Insert after for empty nodes (from === to).
		if ( cursor === nodeModelRange.to ) {
			txInsert = ve.dm.Transaction.newFromInsertion(
				documentModel, nodeModel.getOuterRange().to, emptyParagraph
			);
		} else if ( cursor === nodeModelRange.from ) {
			txInsert = ve.dm.Transaction.newFromInsertion(
				documentModel, nodeModel.getOuterRange().from, emptyParagraph
			);
			advanceCursor = false;
		}
	} else if ( e.shiftKey && nodeModel.hasSignificantWhitespace() ) {
		// Insert newline
		txInsert = ve.dm.Transaction.newFromInsertion( documentModel, range.from, '\n' );
	} else if ( !node.splitOnEnter() ) {
		// Cannot split, so insert some appropriate node

		insertEmptyParagraph = false;
		if ( documentModel.hasSlugAtOffset( range.from ) ) {
			insertEmptyParagraph = true;
		} else {
			prevContentOffset = documentModel.data.getNearestContentOffset(
				cursor,
				-1
			);
			if ( prevContentOffset === -1 ) {
				insertEmptyParagraph = true;
			}
		}

		if ( insertEmptyParagraph ) {
			txInsert = ve.dm.Transaction.newFromInsertion(
				documentModel, cursor, emptyParagraph
			);
		} else {
			// Act as if cursor were at previous content offset
			cursor = prevContentOffset;
			node = surface.documentView.getBranchNodeFromOffset( cursor );
			txInsert = undefined;
			// Continue to traverseUpstream below. That will succeed because all
			// ContentBranchNodes have splitOnEnter === true.
		}
		insertEmptyParagraph = undefined;
	}

	// Assertion: if txInsert === undefined then node.splitOnEnter() === true

	if ( txInsert === undefined ) {
		// This node has splitOnEnter = true. Traverse upstream until the first node
		// that has splitOnEnter = false, splitting each node as it is reached. Set
		// outermostNode to the last splittable node.

		node.traverseUpstream( function ( node ) {
			if ( !node.splitOnEnter() ) {
				return false;
			}
			stack.splice(
				stack.length / 2,
				0,
				{ type: '/' + node.type },
				node.getModel().getClonedElement()
			);
			outermostNode = node;
			if ( e.shiftKey ) {
				return false;
			} else {
				return true;
			}
		} );

		outerParent = outermostNode.getModel().getParent();
		outerChildrenCount = outerParent.getChildren().length;

		if (
			// This is a list item
			outermostNode.type === 'listItem' &&
			// This is the last list item
			outerParent.getChildren()[ outerChildrenCount - 1 ] === outermostNode.getModel() &&
			// There is one child
			outermostNode.children.length === 1 &&
			// The child is empty
			node.getModel().length === 0
		) {
			// Enter was pressed in an empty list item.
			list = outermostNode.getModel().getParent();
			if ( list.getChildren().length === 1 ) {
				// The list item we're about to remove is the only child of the list
				// Remove the list
				txInsert = ve.dm.Transaction.newFromRemoval(
					documentModel, list.getOuterRange()
				);
			} else {
				// Remove the list item
				txInsert = ve.dm.Transaction.newFromRemoval(
					documentModel, outermostNode.getModel().getOuterRange()
				);
				surface.model.change( txInsert );
				range = txInsert.translateRange( range );
				// Insert a paragraph
				txInsert = ve.dm.Transaction.newFromInsertion(
					documentModel, list.getOuterRange().to, emptyParagraph
				);
			}
			advanceCursor = false;
		} else {
			// We must process the transaction first because getRelativeContentOffset can't help us yet
			txInsert = ve.dm.Transaction.newFromInsertion( documentModel, range.from, stack );
		}
	}

	// Commit the transaction
	surface.model.change( txInsert );
	range = txInsert.translateRange( range );

	// Now we can move the cursor forward
	if ( advanceCursor ) {
		cursor = documentModel.data.getRelativeContentOffset( range.from, 1 );
	} else {
		cursor = documentModel.data.getNearestContentOffset( range.from );
	}
	if ( cursor === -1 ) {
		// Cursor couldn't be placed in a nearby content node, so create an empty paragraph
		surface.model.change(
			ve.dm.Transaction.newFromInsertion(
				documentModel, range.from, emptyParagraph
			)
		);
		surface.model.setLinearSelection( new ve.Range( range.from + 1 ) );
	} else {
		surface.model.setLinearSelection( new ve.Range( cursor ) );
	}
	// Reset and resume polling
	surface.surfaceObserver.clear();
	// TODO: This setTimeout appears to be unnecessary (we're not render-locked)
	setTimeout( function () {
		surface.checkSequences();
	} );

	return true;
};

/* Registration */

ve.ce.keyDownHandlerFactory.register( ve.ce.LinearEnterKeyDownHandler );
