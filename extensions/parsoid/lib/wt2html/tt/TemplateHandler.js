/**
 * Template and template argument handling, first cut.
 *
 * AsyncTokenTransformManager objects provide preprocessor-frame-like
 * functionality once template args etc are fully expanded, and isolate
 * individual transforms from concurrency issues. Template expansion is
 * controlled using a tplExpandData structure created independently for each
 * handled template tag.
 */

'use strict';

var coreutil = require('util');
var async = require('async');
var ParserFunctions = require('./ParserFunctions.js').ParserFunctions;
var TokenTransformManager = require('../TokenTransformManager.js');
var TokenHandler = require('./TokenHandler.js');
var AttributeTransformManager = TokenTransformManager.AttributeTransformManager;
var TokenAccumulator = TokenTransformManager.TokenAccumulator;
var defines = require('../parser.defines.js');
var TemplateRequest = require('../../mw/ApiRequest.js').TemplateRequest;
var Util = require('../../utils/Util.js').Util;
var DU = require('../../utils/DOMUtils.js').DOMUtils;

// define some constructor shortcuts
var KV = defines.KV;
var CommentTk = defines.CommentTk;
var NlTk = defines.NlTk;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;


/**
 * @class
 * @extends TokenHandler
 * @constructor
 */
function TemplateHandler() {
	TokenHandler.apply(this, arguments);
	// Set this here so that it's available in the TokenStreamPatcher,
	// which continues to inherit from TemplateHandler.
	this.parserFunctions = new ParserFunctions(this.env);
}
coreutil.inherits(TemplateHandler, TokenHandler);

TemplateHandler.prototype.rank = 1.1;

TemplateHandler.prototype.init = function() {
	// Register for template and templatearg tag tokens
	this.manager.addTransform(this.onTemplate.bind(this),
		"TemplateHandler:onTemplate", this.rank, 'tag', 'template');
	// Template argument expansion
	this.manager.addTransform(this.onTemplateArg.bind(this),
		"TemplateHandler:onTemplateArg", this.rank, 'tag', 'templatearg');
};

/**
 * Main template token handler
 *
 * Expands target and arguments (both keys and values) and either directly
 * calls or sets up the callback to _expandTemplate, which then fetches and
 * processes the template.
 */
TemplateHandler.prototype.onTemplate = function(token, frame, cb) {
	var env = this.env;

	// magic word variables can be mistaken for templates
	try {
		var magicWord = this.checkForMagicWordVariable(token);
		if (magicWord) {
			cb({ tokens: Array.isArray(magicWord) ? magicWord : [magicWord] });
			return;
		}
	} catch (e) {
		env.log("error", "Exception checking magic word for token: ", token);
	}

	var state = {
		token: token,
		wrapperType: 'mw:Transclusion',
		wrappedObjectId: env.newObjectId(),
		srcCB: this._startTokenPipeline,
	};

	if (this.options.wrapTemplates) {
		state.recordArgDict = true;

		// Uncomment to use DOM-based template expansion
		// TODO gwicke: Determine when to use this!
		// - Collect stats per template and classify templates into
		// balanced/unbalanced ones based on it
		// - Always force nesting for new templates inserted by the VE
		//  state.srcCB = this._startDocumentPipeline;

		// Default to 'safe' token-based template encapsulation for now.
	}

	var text = token.dataAttribs.src;
	var tgt = this.resolveTemplateTarget(state, token.attribs[0].k);
	var accumReceiveToksFromSibling;
	var accumReceiveToksFromChild;

	// console.warn("\ttgt", tgt);
	if (this.options.wrapTemplates && tgt === null) {
		// Target contains tags, convert template braces and pipes back into text
		// Re-join attribute tokens with '=' and '|'
		this.convertAttribsToString(state, token.attribs, cb);
		return;
	}
	if (env.conf.parsoid.usePHPPreProcessor) {
		if (this.options.wrapTemplates) {
			// Use MediaWiki's action=expandtemplates preprocessor
			// We'll never get to frame depth beyond 1 in this scenario
			// which means cached content in this frame will not be used
			// by any child frames since there won't be any children.
			// So, it is sufficient to pass in '[]' in place of attribs
			// since the cache key for Frame doesn't matter.
			//
			// However, tokenizer needs to use 'text' as the cache key
			// for caching expanded tokens from the expanded transclusion text
			// that we get from the preprocessor.
			var templateName = tgt.target;
			// Check if we have an expansion for this template in the cache
			// already
			var cachedTransclusion = env.transclusionCache[text];
			if (cachedTransclusion) {
				// cache hit: reuse the expansion DOM
				var opts = { setDSR: true, isForeignContent: true };
				var toks = DU.encapsulateExpansionHTML(env, token, cachedTransclusion, opts);
				cb({ tokens: toks });
			} else {
				// Use a TokenAccumulator to divide the template processing
				// in two parts: The child part will take care of the main
				// template element (including parameters) and the sibling
				// will process the returned template expansion
				state.accum = new TokenAccumulator(this.manager, cb);
				accumReceiveToksFromSibling = state.accum.receiveToksFromSibling.bind(state.accum);
				accumReceiveToksFromChild = state.accum.receiveToksFromChild.bind(state.accum);
				var srcHandler = state.srcCB.bind(
						this, state, frame,
						accumReceiveToksFromSibling,
						{ name: templateName, attribs: [], cacheKey: text });

				// Process the main template element
				this._encapsulateTemplate(state,
					accumReceiveToksFromChild);
				// Fetch and process the template expansion
				this.fetchExpandedTpl(env.page.name || '',
						text, accumReceiveToksFromSibling, srcHandler);
			}
		} else {
			// We don't perform recursive template expansion- something
			// template-like that the PHP parser did not expand. This is
			// encapsulated already, so just return the plain text.
			if (Util.isTemplateToken(token)) {
				this.convertAttribsToString(state, token.attribs, cb);
				return;
			} else {
				cb({ tokens: [ Util.tokensToString([token]) ] });
			}
		}
	} else {
		if (this.options.wrapTemplates) {
			// Use a TokenAccumulator to divide the template processing
			// in two parts: The child part will take care of the main
			// template element (including parameters) and the sibling
			// will do the template expansion
			state.accum = new TokenAccumulator(this.manager, cb);
			// console.warn("onTemplate created TA-" + state.accum.uid);
			accumReceiveToksFromSibling = state.accum.receiveToksFromSibling.bind(state.accum);
			accumReceiveToksFromChild = state.accum.receiveToksFromChild.bind(state.accum);

			// Process the main template element
			this._encapsulateTemplate(state,
				state.accum.receiveToksFromChild.bind(state.accum));
		} else {
			// Don't wrap templates, so we don't need to use the
			// TokenAccumulator and can return the expansion directly
			accumReceiveToksFromSibling = cb;
		}
		// expand argument keys, with callback set to next processing step
		// XXX: would likely be faster to do this in a tight loop here
		var atm = new AttributeTransformManager(
					this.manager,
					{wrapTemplates: false, inTemplate: true},
					this._expandTemplate.bind(this, state, frame, tgt,
						accumReceiveToksFromSibling)
				);
		accumReceiveToksFromSibling({tokens: [], async: true});
		atm.process(token.attribs);
	}
};

/**
 * Parser functions also need template wrapping
 */
TemplateHandler.prototype._parserFunctionsWrapper = function(state, cb, ret) {
	if (ret.tokens) {
		// This is only for the Parsoid native expansion pipeline used in
		// parser tests. The "" token sometimes changes foster parenting
		// behavior and trips up some tests.
		var i = 0;
		while (i < ret.tokens.length) {
			if (ret.tokens[i] === "") {
				ret.tokens.splice(i, 1);
			} else {
				i++;
			}
		}
		this._onChunk(state, cb, ret.tokens);
	}
	if (!ret.async) {
		// Now, ready to finish up
		this._onEnd(state, cb);
	}
};

/**
 * Check if token is a magic word masquerading as a template
 * - currently only DEFAULTSORT and DISPLAYTITLE are considered
 */
TemplateHandler.prototype.checkForMagicWordVariable = function(tplToken) {
	// Deal with the following scenarios:
	//
	// 0. Simple:               {{!}}
	// 1. Normal string:        {{DEFAULTSORT:foo}}
	// 2. String with entities: {{DEFAULTSORT:"foo"bar}}
	// 3. Templated key:        {{DEFAULTSORT:{{foo}}bar}}

	var property, key, propAndKey, keyToks;
	var magicWord = tplToken.attribs[0].k;

	if (magicWord.constructor === String) {
		// Scenario 0. or 1. above -- common case
		propAndKey = magicWord.match(/^([^:]+:?)(.*)$/);
		if (propAndKey) {
			property = propAndKey[1];
			key = propAndKey[2];
		}
	} else if (Array.isArray(magicWord)) {
		// Scenario 2. or 3. above -- uncommon case

		property = magicWord[0];
		if (!property || property.constructor !== String) {
			// FIXME: We don't know if this is a magic word at this point.
			// Ex: {{ {{echo|DEFAULTSORT}}:foo }}
			//     {{ {{echo|lc}}:foo }}
			// This requires more info from the preprocessor than
			// we have currently. This will be handled at a later point.
			return null;
		}

		propAndKey = property.match(/^([^:]+:?)(.*)$/);
		if (propAndKey) {
			property = propAndKey[1];
			key = propAndKey[2];
		}

		keyToks = [key].concat(magicWord.slice(1));
	}

	// TODO gwicke: factor out generic magic word (and parser function) round-tripping logic!

	if (!property) {
		return null;
	}

	property = property.trim();
	var name = this.manager.env.conf.wiki.magicWords[property];

	// try without the colon
	if (!name) {
		name = this.manager.env.conf.wiki.magicWords[property.slice(0, -1)];
	}

	// special case for {{!}} magic word
	if (name === "!") {
		// If we're not at the top level, return a table cell. This will always
		// be the case. Either {{!}} was tokenized as a td, or it is tokenized
		// as template but the recursive call to fetch its content returns a
		// single | in an ambiguous context which will again be tokenized as td.
		if (!this.atTopLevel) {
			return [new TagTk("td")];
		}

		var state = {
			token: tplToken,
			wrapperType: "mw:Transclusion",
			wrappedObjectId: this.manager.env.newObjectId(),
		};

		this.resolveTemplateTarget(state, "!");
		var toks = this.getEncapsulationInfo(state, ["|"]);
		toks.push(this.getEncapsulationInfoEndTag(state));
		var argInfo = this.getArgInfo(state);
		toks[0].dataAttribs.tmp.tplarginfo = JSON.stringify(argInfo);
		return toks;
	} else if (Util.magicMasqs.has(name)) {
		var templatedKey = false;
		if (keyToks) {
			// Check if any part of the key is templated
			for (var i = 0, n = keyToks.length; i < n; i++) {
				if (Util.isTemplateToken(keyToks[i])) {
					templatedKey = true;
					break;
				}
			}
			key = Util.tokensToString(keyToks);
		}

		var pageProp = 'mw:PageProp/';
		if (name === 'defaultsort') {
			pageProp += 'category';
		}
		pageProp += name;

		var metaToken = new SelfclosingTagTk(
			'meta', [ new KV('property', pageProp) ],
			Util.clone(tplToken.dataAttribs)
		);

		if (templatedKey) {
			// No shadowing if templated
			//
			// SSS FIXME: post-tpl-expansion, WS won't be trimmed. How do we handle this?
			metaToken.addAttribute("content", keyToks);
		} else {
			// Leading/trailing WS should be stripped
			key = key.trim();

			var src = (tplToken.dataAttribs || {}).src;
			if (src) {
				// If the token has original wikitext, shadow the sort-key
				var origKey = src.replace(/[^:]+:?/, '').replace(/}}$/, '');
				metaToken.addNormalizedAttribute("content", key, origKey);
			} else {
				// If not, this token came from an extension/template
				// in which case, dont bother with shadowing since the token
				// will never be edited directly.
				metaToken.addAttribute("content", key);
			}
		}
		return metaToken;
	}

	return null;
};

TemplateHandler.prototype.resolveTemplateTarget = function(state, targetToks) {
	function resolvabilityInfo(tokens) {
		var maybeTarget = Util.tokensToString(tokens, true);
		if (Array.isArray(maybeTarget)) {
			var allString = true;
			var newTarget = maybeTarget[0];
			var tgtTokens = maybeTarget[1];
			for (var i = 0, l = tgtTokens.length; i < l; i++) {
				var ntt = tgtTokens[i];
				if (ntt.constructor === String) {
					newTarget += ntt;
				} else if (ntt.constructor === SelfclosingTagTk) {
					allString = false;
					// Quotes are valid template targets
					if (ntt.name === 'mw-quote') {
						newTarget += ntt.value;
					} else if (!Util.isEmptyLineMetaToken(ntt)
							&& ntt.name !== 'template'
							&& ntt.name !== 'templatearg') {
						// We are okay with empty (comment-only) lines,
						// {{..}} and {{{..}}} in template targets.
						return { isStr: false };
					}
				} else if (ntt.constructor === CommentTk) {
					// Ignore comments as well
					allString = false;
				} else if (ntt.constructor === TagTk || ntt.constructor === EndTagTk) {
					return { isStr: false };
				}
			}

			return { isStr: true, isSimpleTgt: allString, newTarget: newTarget };
		} else {
			return { isStr: true, isSimpleTgt: true };
		}
	}

	var env = this.manager.env;

	// Convert the target to a string while stripping all non-text tokens
	var target = Util.tokensToString(targetToks).trim();

	// strip subst for now.
	target = target.replace(/^(safe)?subst:/, '');

	// Check if we have a parser function.
	//
	// Unalias to canonical form and look in config.functionHooks
	var pieces = target.split(':');
	var prefix = pieces[0].trim();
	var lowerPrefix = prefix.toLowerCase();
	var magicWordAlias = env.conf.wiki.magicWords[prefix] || env.conf.wiki.magicWords[lowerPrefix];
	var translatedPrefix = magicWordAlias || lowerPrefix || '';

	// The check for pieces.length > 1 is require to distinguish between
	// {{lc:FOO}} and {{lc|FOO}}.  The latter is a template transclusion
	// even though the target (=lc) matches a registered parser-function name.
	if ((magicWordAlias && this.parserFunctions && this.parserFunctions['pf_' + magicWordAlias]) ||
		(pieces.length > 1 && (translatedPrefix[0] === '#' || env.conf.wiki.functionHooks.has(translatedPrefix)))) {
		state.parserFunctionName = translatedPrefix;
		return {
			isPF: true,
			prefix: prefix,
			target: 'pf_' + translatedPrefix,
			pfArg: target.substr(prefix.length + 1),
		};
	}

	// We are dealing with a real template, not a parser function.
	// Apply more stringent standards for template targets.
	var tgtInfo = resolvabilityInfo(targetToks);
	if (tgtInfo.isStr && !tgtInfo.isSimpleTgt) {
		// resolvabilityInfo found a new target based on the target tokens. This
		// happens when the target contains special characters, specially quotes.
		// For an example, look at T96090.

		// Without a trim(), we get bug T147742 because
		// the prefix === target check below fails!
		target = tgtInfo.newTarget.trim();
		pieces = target.split(':');
		prefix = pieces[0].trim();
		lowerPrefix = prefix.toLowerCase();
	}

	if (tgtInfo.isStr) {
		// FIXME: resolveTitle adds namespace prefix when it resolves
		// fragments and relative titles. Maybe we should add a flag to
		// have it do in all cases.
		if (prefix === target && !/^[#\/\.]/.test(target)) {
			var namespaceId = env.conf.wiki.canonicalNamespaces.template;
			target = env.conf.wiki.namespaceNames[namespaceId] + ':' + target;
		}

		// Resolve a possibly relative link and
		// normalize the target before template processing.
		var title;
		try {
			title = env.resolveTitle(target);
		} catch (e) {
			// Invalid template target!
			return null;
		}

		// Entities in transclusions aren't decoded in the PHP parser
		// So, treat the title as a url-decoded string!
		title = env.makeTitleFromURLDecodedStr(title, undefined, true);
		if (!title) {
			// Invalid template target!
			return null;
		}

		// data-mw.target.href should be a url
		state.resolvedTemplateTarget = env.makeLink(title);

		return { isPF: false, target: title.getPrefixedDBKey() };
	} else {
		return null;
	}

};

TemplateHandler.prototype.convertAttribsToString = function(state, attribs, cb) {
	var self = this;
	cb({tokens: [], async: true});

	// Re-join attribute tokens with '=' and '|'
	var attribTokens = [];
	attribs.forEach(function(kv) {
		if (kv.k) {
			attribTokens = Util.flattenAndAppendToks(attribTokens, null, kv.k);
		}
		if (kv.v) {
			attribTokens = Util.flattenAndAppendToks(attribTokens,
				kv.k ? "=" : '',
				kv.v);
		}
		attribTokens.push('|');
	});
	// pop last pipe separator
	attribTokens.pop();

	var tokens = ['{{'].concat(attribTokens, ['}}', new defines.EOFTk()]);

	// Process exploded token in a new pipeline
	var newTokens = [];
	var endCB = function() {
		// Assign the correct rank to the tokens
		var finalTokens = newTokens;
		finalTokens.rank = this.rank;
		cb({ tokens: finalTokens });
	};
	Util.processContentInPipeline(
		self.manager.env,
		self.manager.frame,
		tokens,
		{
			pipelineType: "tokens/x-mediawiki",
			pipelineOpts: {
				wrapTemplates: self.options.wrapTemplates,
			},
			chunkCB: function(chunk) {
				// SSS FIXME: This pattern of attempting to strip
				// EOFTk from every chunk is a big ugly, but unavoidable
				// since EOF token comes with the entire chunk rather
				// than coming through the end event callback.
				newTokens = newTokens.concat(Util.stripEOFTkfromTokens(chunk));
			},
			endCB: endCB.bind(this),
		}
	);
};

/**
 * Fetch, tokenize and token-transform a template after all arguments and the
 * target were expanded.
 */
TemplateHandler.prototype._expandTemplate = function(state, frame, resolvedTgt, cb, attribs) {
	var env = this.manager.env;
	var target = attribs[0].k;

	if (!target) {
		env.log('debug', 'No target! ', attribs);
	}

	if (!state.resolveTemplateTarget) {
		// We couldn't get the proper target before going through the
		// AttributeTransformManager, so try again now
		resolvedTgt = this.resolveTemplateTarget(state, target);
		if (resolvedTgt === null) {
			// Target contains tags, convert template braces and pipes back into text
			// Re-join attribute tokens with '=' and '|'
			this.convertAttribsToString(state, attribs, cb);
			return;
		}
	}

	// TODO:
	// check for 'subst:'
	// check for variable magic names
	// check for msg, msgnw, raw magics
	// check for parser functions

	// XXX: wrap attribs in object with .dict() and .named() methods,
	// and each member (key/value) into object with .tokens(), .dom() and
	// .wikitext() methods (subclass of Array)

	var res;
	target = resolvedTgt.target;
	if (resolvedTgt.isPF) {
		// FIXME: Parsoid may not have implemented the parser function natively
		// Emit an error message, but encapsulate it so it roundtrips back.
		if (!this.parserFunctions[target]) {
			res = [ "Parser function implementation for " + target + " missing in Parsoid." ];
			res.rank = this.rank;
			if (this.options.wrapTemplates) {
				res.push(this.getEncapsulationInfoEndTag(state));
			}
			cb({ tokens: res });
			return;
		}

		var pfAttribs = new defines.Params(attribs);
		pfAttribs[0] = new KV(resolvedTgt.pfArg, []);
		env.log('debug', 'entering prefix', target, state.token);
		var newCB;
		if (this.options.wrapTemplates) {
			newCB = this._parserFunctionsWrapper.bind(this, state, cb);
		} else {
			newCB = cb;
		}
		this.parserFunctions[target](state.token, frame, newCB, pfAttribs);
		return;
	}

	var checkRes = frame.loopAndDepthCheck(target, env.conf.parsoid.maxDepth);
	if (checkRes) {
		// Loop detected or depth limit exceeded, abort!
		res = [
				checkRes,
				new TagTk('a', [{ k: 'href', v: target }]),
				target,
				new EndTagTk('a'),
			];
		res.rank = this.manager.phaseEndRank;
		cb({ tokens: res });
		return;
	}

	// XXX: notes from brion's mediawiki.parser.environment
	// resolve template name
	// load template w/ canonical name
	// load template w/ variant names (language variants)

	// strip template target
	attribs = attribs.slice(1);

	// For now, just fetch the template and pass the callback for further
	// processing along.
	var srcHandler = state.srcCB.bind(
		this, state, frame, cb,
		{ name: target, attribs: attribs, cacheKey: target }
	);
	this._fetchTemplateAndTitle(target, cb, srcHandler, state);
};

/**
 * Process a fetched template source to a document, enforcing proper nesting
 * along the way.
 */
TemplateHandler.prototype._startDocumentPipeline = function(state, frame, cb, tplArgs, err, src) {
	// We have a choice between aborting or keeping going and reporting the
	// error inline.
	// TODO: report as special error token and format / remove that just
	// before the serializer. (something like <mw:error ../> as source)
	if (err) {
		src = '';
		//  this.manager.env.errCB(err);
	}

	this.manager.env.log('debug', 'TemplateHandler._startDocumentPipeline', tplArgs.name, tplArgs.attribs);
	Util.processContentInPipeline(
		this.manager.env,
		this.manager.frame,
		src,
		{
			// Full pipeline all the way to DOM
			pipelineType: 'text/x-mediawiki/full',
			pipelineOpts: {
				isInclude: true,
				// we *might* be able to get away without this if we transfer
				// more than just the about when unwrapping
				wrapTemplates: false,
				// (SSS FIXME: but why?? This function is not used currently)
				// suppress paragraphs,
				// Should this be the default in all cases?
				noPWrapping: true,
			},
			tplArgs: tplArgs,
			documentCB: this._onDocument.bind(this, state, cb),
		}
	);
};

/**
 * Process a fetched template source to a token stream
 */
TemplateHandler.prototype._startTokenPipeline = function(state, frame, cb, tplArgs, err, src, type) {
	// The type parameter is passed in from the src fetcher. Typically it is
	// 'text/x-mediawiki' since we are fetching wikitext (search for it in
	// ApiRequest). We can probably remove it even, as it seems unlikely that
	// we will ever have other input types here.

	// We have a choice between aborting or keeping going and reporting the
	// error inline.
	// TODO: report as special error token and format / remove that just
	// before the serializer. (something like <mw:error ../> as source)
	if (err) {
		src = '';
		//  this.manager.env.errCB(err);
	}

	var pConf = this.manager.env.conf.parsoid;
	if (pConf.dumpFlags && pConf.dumpFlags.indexOf("tplsrc") !== -1) {
		console.log("=================================");
		console.log(tplArgs.name);
		console.log("---------------------------------");
		console.log(src);
		console.log("---------------------------------");
	}

	this.manager.env.log('debug', 'TemplateHandler._startTokenPipeline', tplArgs.name, tplArgs.attribs);

	// Get a nested transformation pipeline for the input type. The input
	// pipeline includes the tokenizer, synchronous stage-1 transforms for
	// 'text/wiki' input and asynchronous stage-2 transforms).
	Util.processContentInPipeline(
		this.manager.env,
		this.manager.frame,
		src,
		{
			pipelineType: type || 'text/x-mediawiki',
			pipelineOpts: {
				inTemplate: true,
				isInclude: true,
				// NOTE: No template wrapping required for nested templates.
				wrapTemplates: false,
				extTag: this.options.extTag,
			},
			tplArgs: tplArgs,
			chunkCB: this._onChunk.bind (this, state, cb),
			endCB: this._onEnd.bind (this, state, cb),
		}
	);
};

TemplateHandler.prototype.getEncapsulationInfo = function(state, chunk) {
	// TODO
	// * only add this information for top-level includes, but track parameter
	// expansion in lower-level templates
	// * ref all tables to this (just add about)
	// * ref end token to this, add property="mw:Transclusion/End"

	var attrs = [
		new KV('typeof', state.wrapperType),
		new KV('about', '#' + state.wrappedObjectId),
	];
	var dataParsoid = {
		tsr: Util.clone(state.token.dataAttribs.tsr),
		src: state.token.dataAttribs.src,
		tmp: {},  // We'll add the arginfo here if necessary
	};

	var meta = [new SelfclosingTagTk('meta', attrs, dataParsoid)];
	chunk = chunk ? meta.concat(chunk) : meta;
	chunk.rank = this.rank;
	return chunk;
};

TemplateHandler.prototype.getEncapsulationInfoEndTag = function(state) {
	var tsr = state.token.dataAttribs.tsr;
	return new SelfclosingTagTk('meta',
				[
					new KV('typeof', state.wrapperType + '/End'),
					new KV('about', '#' + state.wrappedObjectId),
				], {
					tsr: [null, tsr ? tsr[1] : null],
				});
};

/**
 * Parameter processing helpers
 */
var isSimpleParam = function(tokens) {
	var isSimpleToken = function(token) {
		return (token.constructor === String ||
				token.constructor === CommentTk ||
				token.constructor === NlTk);
	};
	if (!Array.isArray(tokens)) {
		return isSimpleToken(tokens);
	}
	return tokens.every(isSimpleToken);
};

// Add its HTML conversion to a parameter. The eachCb is only
// used to signal an error to async.each
var getParamHTML = function(paramData, eachCb) {
	var param = paramData.param;
	var srcStart = paramData.info.srcOffsets[2];
	var srcEnd = paramData.info.srcOffsets[3];
	if (paramData.info.spc) {
		srcStart += paramData.info.spc[2].length;
		srcEnd -= paramData.info.spc[3].length;
	}

	Util.processContentInPipeline(
		this.manager.env, this.manager.frame,
		param.wt,
		{
			pipelineType: "text/x-mediawiki/full",
			pipelineOpts: {
				isInclude: false,
				wrapTemplates: true,
				// No need to do paragraph-wrapping here
				noPWrapping: true,
				// TODO: This helps in the case of unnamed
				// parameters which start with whitespace,
				// but it's not be the correct solution
				// for cases with significant start-of-line
				// chars inserted after "\n".
				noPre: true,
			},
			srcOffsets: [ srcStart, srcEnd ],
			documentCB: function(html) {
				// FIXME: We're better off setting a pipeline option above
				// to skip dsr computation to begin with.  Worth revisitting
				// if / when `addHTMLTemplateParameters` is enabled.
				// Remove DSR from children
				DU.visitDOM(html.body, function(node) {
					if (!DU.isElt(node)) { return; }
					var dp = DU.getDataParsoid(node);
					dp.dsr = undefined;
				});
				param.html = DU.ppToXML(html.body, { innerXML: true });
				eachCb(null);
			},
		}
	);
};

/**
 * Process the main template element, including the arguments
 */
TemplateHandler.prototype._encapsulateTemplate = function(state, cb) {
	var i, n;
	var env = this.manager.env;
	var chunk = this.getEncapsulationInfo(state);

	if (!this.options.inTemplate && state.recordArgDict) {
		// Get the arg dict
		var argInfo = this.getArgInfo(state);
		var argDict = argInfo.dict;

		if (env.conf.parsoid.addHTMLTemplateParameters) {
			// Collect the parameters that need parsing into HTML, that is,
			// those that are not simple strings.
			// This optimizes for the common case where all are simple strings,
			// in which we don't need to go async.
			var params = [];
			for (i = 0, n = argInfo.paramInfos.length; i < n; i++) {
				var paramInfo = argInfo.paramInfos[i];
				var param = argDict.params[paramInfo.k];
				var paramTokens;
				if (paramInfo.named) {
					paramTokens = state.token.getAttribute(paramInfo.k);
				} else {
					paramTokens = state.token.attribs[paramInfo.k].v;
				}

				// No need to pass through a whole sub-pipeline to get the
				// html if the param is either a single string, or if it's
				// just text, comments or newlines.
				if (paramTokens &&
						(paramTokens.constructor === String ||
							isSimpleParam(paramTokens))) {
					param.html = param.wt;
				} else if (param.wt.match(/^https?:\/\/[^[\]{}\s]*$/)) {
					// If the param is just a simple URL, we can process it to
					// HTML directly without going through a sub-pipeline.
					param.html = "<a rel='mw:ExtLink' href='" + param.wt.replace(/'/g, '&#39;') +
						"'>" + param.wt + "</a>";
				} else {
					// Prepare the data needed to parse to HTML
					params.push({
						param: param,
						info: paramInfo,
						tokens: paramTokens,
					});
				}
			}

			if (params.length) {
				// TODO: We could avoid going async by checking if all params are strings
				// and, in that case returning them immediately.
				async.each(params, getParamHTML.bind(this), function(err) {
					// Use a data-attribute to prevent the sanitizer from stripping this
					// attribute before it reaches the DOM pass where it is needed.
					chunk[0].dataAttribs.tmp.tplarginfo = JSON.stringify(argInfo);
					env.log('debug', 'TemplateHandler._encapsulateTemplate', chunk);
					cb({tokens: chunk});
				}.bind(this));

				cb({tokens: [], async: true});
				return;
			} else {
				chunk[0].dataAttribs.tmp.tplarginfo = JSON.stringify(argInfo);
			}
		} else {
			// Don't add the HTML template parameters, just use their wikitext
			chunk[0].dataAttribs.tmp.tplarginfo = JSON.stringify(argInfo);
		}
	}

	env.log('debug', 'TemplateHandler._encapsulateTemplate', chunk);
	cb({tokens: chunk});
};

/**
 * Handle chunk emitted from the input pipeline after feeding it a template
 */
TemplateHandler.prototype._onChunk = function(state, cb, chunk) {
	chunk = Util.stripEOFTkfromTokens(chunk);

	var i, n;
	for (i = 0, n = chunk.length; i < n; i++) {
		if (chunk[i] && chunk[i].dataAttribs && chunk[i].dataAttribs.tsr) {
			chunk[i].dataAttribs.tsr = undefined;
		}
		var t = chunk[i];
		if (t.constructor === SelfclosingTagTk &&
				t.name.toLowerCase() === 'meta' &&
				t.getAttribute('typeof') === 'mw:Placeholder') {
			// replace with empty string to avoid metas being foster-parented out
			chunk[i] = '';
		}
	}

	if (!this.options.wrapTemplates) {
		// Ignore comments in template transclusion mode
		var newChunk = [];
		for (i = 0, n = chunk.length; i < n; i++) {
			if (chunk[i].constructor !== CommentTk) {
				newChunk.push(chunk[i]);
			}
		}
		chunk = newChunk;
	}

	this.manager.env.log('debug', 'TemplateHandler._onChunk', chunk);
	chunk.rank = this.rank;
	cb({tokens: chunk, async: true});
};

/**
 * Handle the end event emitted by the parser pipeline after fully processing
 * the template source.
 */
TemplateHandler.prototype._onEnd = function(state, cb) {
	this.manager.env.log('debug', 'TemplateHandler._onEnd');
	if (this.options.wrapTemplates) {
		var endTag = this.getEncapsulationInfoEndTag(state);
		var res = { tokens: [endTag] };
		res.tokens.rank = this.rank;
		cb(res);
	} else {
		cb({ tokens: [] });
	}
};

/**
 * Handle the sub-DOM produced by a DOM-based template expansion
 *
 * This uses the same encapsulation mechanism as we use for template expansion
 * recycling.
 */
TemplateHandler.prototype._onDocument = function(state, cb, doc) {
	// FIXME: This will only incorporate the wikitext parameters into data-mw,
	// not the HTML ones. For that, the code in _onChunk will have to adapted
	// here.
	var argDict = this.getArgInfo(state).dict;
	var addWrapperAttrs = function(firstNode) {
		// Adds the wrapper attributes to the first element
		firstNode.setAttribute('typeof', state.wrapperType);

		// Update data-mw
		DU.setDataMw(firstNode,
			Object.assign(state.wrapperDataMw || {}, argDict));

		// Update data-parsoid
		DU.setDataParsoid(firstNode, {
			tsr: Util.clone(state.token.dataAttribs.tsr),
			src: state.token.dataAttribs.src,
		});
	};

	var toks = DU.buildDOMFragmentTokens(
		this.manager.env,
		state.token,
		doc,
		addWrapperAttrs,
		{ setDSR: state.token.name === 'extension', isForeignContent: true }
	);

	// All done for this template, so perform a callback without async: set.
	cb({ tokens: toks });
};

/**
 * Get the public data-mw structure that exposes the template name and
 * parameters ExtensionHandler provides its own getArgInfo function.
 */
TemplateHandler.prototype.getArgInfo = function(state) {
	var src = this.manager.env.page.src;
	var params = state.token.attribs;
	var dict = {};
	var paramInfos = [];
	var argIndex = 1;

	// Use source offsets to extract arg-name and arg-value wikitext
	// since the 'k' and 'v' values in params will be expanded tokens
	//
	// Ignore params[0] -- that is the template name
	for (var i = 1, n = params.length; i < n; i++) {
		var srcOffsets = params[i].srcOffsets;
		var kSrc, vSrc;
		if (srcOffsets) {
			kSrc = src.substring(srcOffsets[0], srcOffsets[1]);
			vSrc = src.substring(srcOffsets[2], srcOffsets[3]);
		} else {
			kSrc = params[i].k;
			vSrc = params[i].v;
		}

		var kWt = kSrc.trim();
		var k = Util.tokensToString(params[i].k, true, true);
		if (Array.isArray(k)) {
			// The PHP parser only removes comments and whitespace to construct
			// the real parameter name, so if there were other tokens, use the
			// original text
			k = kWt;
		} else {
			k = k.trim();
		}
		var v = vSrc;

		// Number positional parameters
		var isPositional;
		// Even if k is empty, we need to check v immediately follows. If not,
		// it's a blank parameter name (which is valid) and we shouldn't make it
		// positional.
		if (k === '' && srcOffsets[1] === srcOffsets[2]) {
			isPositional = true;
			k = argIndex.toString();
			argIndex++;
		} else {
			isPositional = false;
			// strip ws from named parameter values
			v = v.trim();
		}

		if (dict[k] === undefined) {
			var paramInfo = {
				k: k,
				srcOffsets: srcOffsets,
			};

			var keySpaceMatch = kSrc.match(/^(\s*)[^]*?(\s*)$/);
			var valueSpaceMatch;

			if (isPositional) {
				// PHP parser does not strip whitespace around
				// positional params and neither will we.
				valueSpaceMatch = [null, '', ''];
			} else {
				paramInfo.named = true;
				valueSpaceMatch = v ? vSrc.match(/^(\s*)[^]*?(\s*)$/) : [null, '', vSrc];
			}

			// Preserve key and value space prefix / postfix, if any.
			// "=" is the default spacing used by the serializer,
			if (keySpaceMatch[1] || keySpaceMatch[2] ||
				valueSpaceMatch[1] || valueSpaceMatch[2]) {
				// Remember non-standard spacing
				paramInfo.spc = [
					keySpaceMatch[1], keySpaceMatch[2],
					valueSpaceMatch[1], valueSpaceMatch[2],
				];
			}

			paramInfos.push(paramInfo);
		}

		dict[k] = { wt: v };
		// Only add the original parameter wikitext if named and different from
		// the actual parameter.
		if (!isPositional && kWt !== k) {
			dict[k].key = {wt: kWt};
		}
	}

	var tplTgtSrcOffsets = params[0].srcOffsets;
	if (tplTgtSrcOffsets) {
		var tplTgtWT = src.substring(tplTgtSrcOffsets[0], tplTgtSrcOffsets[1]);
		return {
			dict: {
				target: {
					wt: tplTgtWT,
					// Add in tpl-target/pf-name info
					// Only one of these will be set.
					'function': state.parserFunctionName,
					href: state.resolvedTemplateTarget,
				},
				params: dict,
			},
			paramInfos: paramInfos,
		};
	}
};

/**
 * Fetch a template
 */
TemplateHandler.prototype._fetchTemplateAndTitle = function(title, parentCB, cb, state) {
	// @fixme normalize name?
	var env = this.manager.env;
	if (title in env.pageCache) {
		// XXX: store type too (and cache tokens/x-mediawiki)
		cb(null, env.pageCache[title] /* , type */);
	} else if (!env.conf.parsoid.fetchTemplates) {
		// TODO: Set mw:Error and provide error info in data-mw
		// see https://phabricator.wikimedia.org/T50900
		var tokens = Util.placeholder('Warning: ' +
				'Page/template fetching disabled, and no cache for ' + title);
		tokens[0].addAttribute('about', '#' + state.wrappedObjectId);
		tokens.push(this.getEncapsulationInfoEndTag(state));
		tokens.rank = this.rank;
		parentCB({ tokens: tokens });
	} else {
		// We are about to start an async request for a template
		env.log('debug', 'Note: trying to fetch ', title);
		// Start a new request if none is outstanding
		if (env.requestQueue[title] === undefined) {
			env.requestQueue[title] = new TemplateRequest(env, title);
		}
		// append request, process in document order
		env.requestQueue[title].once('src', function(err, page) {
			cb(err, page ? page.revision['*'] : null);
		});
		parentCB ({tokens: [], async: true});
	}
};

/**
 * Fetch the preprocessed wikitext for a template-like construct.
 */
TemplateHandler.prototype.fetchExpandedTpl = function(title, text, parentCB, cb) {
	var env = this.manager.env;
	if (!env.conf.parsoid.fetchTemplates) {
		parentCB({ tokens: [ 'Warning: Page/template fetching disabled cannot expand ' + text] });
	} else {
		// We are about to start an async request for a template
		env.log('debug', 'Note: trying to expand ', text);
		parentCB({ tokens: [], async: true });
		env.batcher.preprocess(title, text).nodify(cb);
	}
};

/* ********************** Template argument expansion ****************** */

/**
 * Expand template arguments with tokens from the containing frame.
 */

TemplateHandler.prototype.onTemplateArg = function(token, frame, cb) {
	var args = frame.args.named();
	var attribs = token.attribs;
	var newCB;

	if (this.options.wrapTemplates) {
		// This is a bare use of template arg syntax at the top level
		// outside any template use context.  Wrap this use with RDF attrs.
		// so that this chunk can be RT-ed en-masse.
		var tplHandler = this;
		newCB = function(res) {
			var toks = Util.stripEOFTkfromTokens(res.tokens);
			var state = {
				token: token,
				wrapperType: "mw:Param",
				wrappedObjectId: tplHandler.manager.env.newObjectId(),
			};
			toks = tplHandler.getEncapsulationInfo(state, toks);
			toks.push(tplHandler.getEncapsulationInfoEndTag(state));
			cb({tokens: toks});
		};
	} else {
		newCB = cb;
	}

	this.fetchArg(attribs[0].k, this.lookupArg.bind(this, args, attribs, newCB, cb), cb);
};

TemplateHandler.prototype.fetchArg = function(arg, argCB, asyncCB) {
	if (arg.constructor === String) {
		argCB({tokens: [arg]});
	} else {
		this.manager.frame.expand(arg, {
			wrapTemplates: false,
			type: "tokens/x-mediawiki/expanded",
			asyncCB: asyncCB,
			cb: function(tokens) {
				argCB({tokens: Util.stripEOFTkfromTokens(tokens)});
			},
		});
	}
};

TemplateHandler.prototype.lookupArg = function(args, attribs, cb, asyncCB, ret) {
	var toks    = ret.tokens;
	var argName = toks.constructor === String ? toks : Util.tokensToString(toks).trim();
	var res     = args.dict[argName];

	// The 'res.constructor !== Function' protects against references to
	// tpl-args named 'prototype' or 'constructor' that haven't been passed in.
	if (res !== null && res !== undefined && res.constructor !== Function) {
		if (res.constructor === String) {
			res = [res];
		}
		cb({ tokens: args.namedArgs[argName] ? Util.tokenTrim(res) : res });
	} else if (attribs.length > 1) {
		this.fetchArg(attribs[1].v, cb, asyncCB);
	} else {
		cb({ tokens: [ '{{{' + argName + '}}}' ] });
	}
};

if (typeof module === "object") {
	module.exports.TemplateHandler = TemplateHandler;
}
