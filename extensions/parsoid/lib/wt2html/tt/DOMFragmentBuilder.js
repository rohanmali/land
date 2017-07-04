'use strict';

var coreutil = require('util');
var Util = require('../../utils/Util.js').Util;
var TokenHandler = require('./TokenHandler.js');
var DU = require('../../utils/DOMUtils.js').DOMUtils;
var defines = require('../parser.defines.js');

// define some constructor shortcuts
var TagTk = defines.TagTk;
var EOFTk = defines.EOFTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;


/**
 * @class
 * @extends TokenHandler
 * @constructor
 */
function DOMFragmentBuilder() {
	TokenHandler.apply(this, arguments);
}
coreutil.inherits(DOMFragmentBuilder, TokenHandler);

DOMFragmentBuilder.prototype.scopeRank = 1.99;

DOMFragmentBuilder.prototype.init = function() {
	this.manager.addTransform(this.buildDOMFragment.bind(this),
		'buildDOMFragment', this.scopeRank, 'tag', 'mw:dom-fragment-token');
};

/**
 * Can/should content represented in 'toks' be processed in its own DOM scope?
 * 1. No reason to spin up a new pipeline for plain text
 * 2. In some cases, if templates need not be nested entirely within the
 *    boundary of the token, we cannot process the contents in a new scope.
 */
DOMFragmentBuilder.prototype.subpipelineUnnecessary = function(toks, contextTok) {
	for (var i = 0, n = toks.length; i < n; i++) {
		var t = toks[i];
		var tc = t.constructor;

		// For wikilinks and extlinks, templates should be properly nested
		// in the content section. So, we can process them in sub-pipelines.
		// But, for other context-toks, we back out. FIXME: Can be smarter and
		// detect proper template nesting, but, that can be a later enhancement
		// when dom-scope-tokens are used in other contexts.
		if (contextTok && contextTok.name !== 'wikilink' && contextTok.name !== 'extlink' &&
			tc === SelfclosingTagTk &&
			t.name === 'meta' && t.getAttribute("typeof") === "mw:Transclusion") {
			return true;
		} else if (tc === TagTk || tc === EndTagTk || tc === SelfclosingTagTk) {
			// Since we encountered a complex token, we'll process this
			// in a subpipeline.
			return false;
		}
	}

	// No complex tokens at all -- no need to spin up a new pipeline
	return true;
};

DOMFragmentBuilder.prototype.buildDOMFragment = function(scopeToken, frame, cb) {
	var content = scopeToken.getAttribute("content");
	if (this.subpipelineUnnecessary(content, scopeToken.getAttribute('contextTok'))) {
		// New pipeline not needed. Pass them through
		cb({ tokens: typeof content === "string" ? [content] : content, async: false });
	} else {
		// First thing, signal that the results will be available asynchronously
		cb({ async: true });

		// Source offsets of content
		var srcOffsets = scopeToken.getAttribute("srcOffsets");
		var pipelineOpts = {
			noPre: scopeToken.getAttribute('noPre'),
			noPWrapping: scopeToken.getAttribute('noPWrapping'),
			// Without source offsets for the content, it isn't possible to
			// compute DSR and template wrapping in content. So, users of
			// mw:dom-fragment-token should always set offsets on content
			// that comes from the top-level document.
			wrapTemplates: !!srcOffsets,
		};

		// Process tokens
		Util.processContentInPipeline(
			this.manager.env,
			this.manager.frame,
			// Append EOF
			content.concat([new EOFTk()]),
			{
				pipelineType: "tokens/x-mediawiki/expanded",
				pipelineOpts: pipelineOpts,
				srcOffsets: srcOffsets,
				documentCB: this.wrapDOMFragment.bind(this, cb, scopeToken, pipelineOpts),
			}
		);
	}
};

DOMFragmentBuilder.prototype.wrapDOMFragment = function(cb, scopeToken, opts, dom) {
	// Pass through pipeline options
	var toks = DU.buildDOMFragmentTokens(this.manager.env, scopeToken, dom, false, opts);

	// Nothing more to send cb after this
	cb({tokens: toks, async: false});
};

if (typeof module === "object") {
	module.exports.DOMFragmentBuilder = DOMFragmentBuilder;
}
