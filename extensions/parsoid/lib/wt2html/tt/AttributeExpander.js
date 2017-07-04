/*
 * Generic attribute expansion handler.
 */
'use strict';

var coreutil = require('util');
var Util = require('../../utils/Util.js').Util;
var TokenHandler = require('./TokenHandler.js');
var AttributeTransformManager = require('../TokenTransformManager.js').AttributeTransformManager;
var PegTokenizer = require('../tokenizer.js').PegTokenizer;
var defines = require('../parser.defines.js');

// define some constructor shortcuts
var NlTk = defines.NlTk;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;


function nlTkIndex(nlTkOkay, tokens, atTopLevel) {
	// Moving this check here since it makes the
	// callsite cleaner and simpler.
	if (nlTkOkay) {
		return -1;
	}

	// Check if we have a newline token in the attribute key/value token stream.
	// However, newlines are acceptable inside a <*include*>..</*include*> directive
	// since they are stripped out.
	//
	// var includeRE = !atTopLevel ? /(?:^|\s)mw:Includes\/NoInclude(\/.*)?(?:\s|$)/ : /(?:^|\s)mw:Includes\/(?:Only)?Include(?:Only)?(\/.*)?(?:\s|$)/;
	//
	// SSS FIXME: We cannot support this usage for <*include*> directives currently
	// since they don't go through template encapsulation and don't have a data-mw
	// format with "wt" and "transclusion" parts that we can use to just track bits
	// of wikitext that don't have a DOM representation.
	//
	// So, for now, we just suppress all newlines contained within these directives.
	//
	var includeRE = /(?:^|\s)mw:Includes\/(?:No|Only)?Include(?:Only)?(\/.*)?(?:\s|$)/;
	var inInclude = false;
	for (var i = 0, n = tokens.length; i < n; i++) {
		var t = tokens[i];
		if (t.constructor === SelfclosingTagTk) {
			var type = t.getAttribute("typeof");
			var typeMatch = type ? type.match(includeRE) : null;
			if (typeMatch) {
				inInclude = !typeMatch[1] || !typeMatch[1].match(/\/End$/);
			}
		} else if (!inInclude && t.constructor === NlTk) {
			// newline token outside <*include*>
			return i;
		}
	}

	return -1;
}

function splitTokens(env, token, nlTkPos, tokens, wrapTemplates) {
	// FIXME: It is insufficient to rely merely on wrapTemplates
	// because right now, it is always true. Since tsr values are
	// stripped from template tokens, we use that as a proxy.
	wrapTemplates = wrapTemplates && token.dataAttribs.tsr;

	var buf = [];
	var postNLBuf, startMeta, metaTokens;

	// Split the token array around the first newline token.
	for (var i = 0, l = tokens.length; i < l; i++) {
		var t = tokens[i];
		if (i === nlTkPos) {
			// split here!
			postNLBuf = tokens.slice(i);
			break;
		} else {
			if (wrapTemplates && t.constructor === SelfclosingTagTk) {
				var type = t.getAttribute("typeof");
				var typeMatch = type && type.match(/(mw:(Transclusion|Param|Extension|Includes\/)(.*)?$)/);
				// Don't trip on transclusion end tags and mw:Extension/ref/Marker tags
				if (typeMatch && !typeMatch[1].match(/\/(End|Marker)$/)) {
					startMeta = t;
				}
			}

			buf.push(t);
		}
	}

	if (wrapTemplates && startMeta) {
		// Support template wrapping with the following steps:
		// - Hoist the transclusion start-meta from the first line
		//   to before the token.
		// - Update the start-meta tsr to that of the token.
		// - Record the wikitext between the token and the transclusion
		//   as an unwrappedWT data-parsoid attribute of the start-meta.
		var dp = startMeta.dataAttribs;
		dp.unwrappedWT = env.page.src.substring(token.dataAttribs.tsr[0], dp.tsr[0]);

		// unwrappedWT will be added to the data-mw.parts array which makes
		// this a multi-template-content-block.
		// Record the first wikitext node of this block (required by html->wt serialization)
		dp.firstWikitextNode = token.dataAttribs.stx ? token.name + "_" + token.dataAttribs.stx : token.name;

		// Update tsr[0] only. Unless the end-meta token is moved as well,
		// updating tsr[1] can introduce bugs in cases like:
		//
		//   {|
		//   |{{singlechart|Australia|93|artist=Madonna|album=Girls Gone Wild}}|x
		//   |}
		//
		// which can then cause dirty diffs (the "|" before the x gets dropped).
		dp.tsr[0] = token.dataAttribs.tsr[0];
		metaTokens = [startMeta];

		return { metaTokens: metaTokens, preNLBuf: buf, postNLBuf: postNLBuf };
	} else {
		return { metaTokens: [], preNLBuf: tokens, postNLBuf: [] };
	}
}

/* ----------------------------------------------------------
 * This helper method strips all meta tags introduced by
 * transclusions, etc. and returns the content.
 * ---------------------------------------------------------- */
function stripMetaTags(tokens, wrapTemplates) {
	var buf = [];
	var isPushed = false;
	var hasGeneratedContent = false;

	for (var i = 0, l = tokens.length; i < l; i++) {
		var t = tokens[i];
		if ([TagTk, SelfclosingTagTk].indexOf(t.constructor) !== -1) {
			isPushed = false;
			if (wrapTemplates) {
				// Strip all meta tags.
				var type = t.getAttribute("typeof");
				var typeMatch = type && type.match(/(mw:(Transclusion|Param|Extension|Includes\/)(.*)?$)/);
				if (typeMatch) {
					if (!typeMatch[1].match(/\/End$/)) {
						hasGeneratedContent = true;
					}
				} else {
					isPushed = true;
					buf.push(t);
				}
			}

			if (!isPushed && t.name !== "meta") {
				// Dont strip token if it is not a meta-tag
				buf.push(t);
			}
		} else {
			buf.push(t);
		}
	}

	return { hasGeneratedContent: hasGeneratedContent, value: buf };
}


/**
 * @class
 *
 * Generic attribute expansion handler.
 *
 * @extends TokenHandler
 * @constructor
 */
function AttributeExpander() {
	TokenHandler.apply(this, arguments);
}
coreutil.inherits(AttributeExpander, TokenHandler);

AttributeExpander.prototype.rank = 1.12;
AttributeExpander.prototype.skipRank = 1.13; // should be higher than all other ranks above

AttributeExpander.prototype.init = function() {
	this.tokenizer = new PegTokenizer(this.env);

	// XXX: only register for tag tokens?
	this.manager.addTransform(this.onToken.bind(this),
		'AttributeExpander:onToken', this.rank, 'any');
};

/**
 * Token handler
 *
 * Expands target and arguments (both keys and values) and either directly
 * calls or sets up the callback to _expandTemplate, which then fetches and
 * processes the template.
 *
 * @private
 * @param {Token} token -- token whose attrs being expanded
 * @param {Frame} frame -- unused here, passed in by AsyncTTM to all handlers
 * @param {Function} cb -- callback receiving the expanded token
 */
AttributeExpander.prototype.onToken = function(token, frame, cb) {
	// console.warn( 'AttributeExpander.onToken: ', JSON.stringify( token ) );
	if ((token.constructor === TagTk || token.constructor === SelfclosingTagTk) &&
		// Do not process dom-fragment tokens: a separate handler deals with them.
		token.attribs && token.attribs.length &&
		token.name !== 'mw:dom-fragment-token' &&
		(token.name !== 'meta' ||
		!/mw:(TSRMarker|Placeholder|Transclusion|Param|Includes|Extension\/ref\/Marker)/.test(token.getAttribute('typeof')))
	) {
		cb({ async: true });
		(new AttributeTransformManager(
			this.manager,
			{ wrapTemplates: this.options.wrapTemplates },
			this._returnAttributes.bind(this, token, cb)
		)).process(token.attribs);
	} else {
		cb({ tokens: [token] });
	}
};

/**
 * Callback for attribute expansion in AttributeTransformManager
 *
 * @private
 */
AttributeExpander.prototype._returnAttributes = function(token, cb, expandedAttrs) {
	// SSS FIXME: This is mostly useless.
	//
	// wrapTemplates will always be true for all tokens from the top-level
	// as well as tokens coming from template expansions because template
	// content only goes through the PEG in a separate pipeline and the
	// resulting tokens are merged back into the main top-level pipeline
	// which has wrapTemplates set to true. To see this, look at the
	// default pipeline type in ext.core.TemplateHandler.js:_startTokenPipeline
	// and check the components of that pipeline type in mediawiki.parser.js
	//
	// Currently, this doesn't matter a whole lot since templates are currently
	// fully expanded with the PHP preprocessor and we encounter transclusions
	// only from the top-level. However, when T93368 scenarios happen (or when
	// we are in the native parsoid pipeline), this could be a more serious issue.
	var wrapTemplates = this.options.wrapTemplates;
	var env = this.manager.env;
	var modified = false;
	var metaTokens = [];
	var postNLToks = [];
	var skipRank = this.skipRank;
	var tmpDataMW;
	var oldAttrs = token.attribs;
	// Build newAttrs lazily (on-demand) to avoid creating
	// objects in the common case where nothing of significance
	// happens in this code.
	var newAttrs = null;
	var nlTkPos = -1;
	var i, l;
	var nlTkOkay = Util.isHTMLTag(token) || !Util.isTableTag(token);

	// Identify attributes that were generated in full or in part using templates
	for (i = 0, l = oldAttrs.length; i < l; i++) {
		var oldA = oldAttrs[i];
		var expandedA = expandedAttrs[i];

		// Preserve the key and value source, if available.
		// But, if 'oldA' wasn't cloned, expandedA will be the same as 'oldA'.
		if (oldA !== expandedA) {
			expandedA.ksrc = oldA.ksrc;
			expandedA.vsrc = oldA.vsrc;
			expandedA.srcOffsets = oldA.srcOffsets;
		}

		// Deal with two template-expansion scenarios for the attribute key (not value)
		//
		// 1. We have a template that generates multiple attributes of this token
		//    as well as content after the token.
		//    Ex: infobox templates from aircraft, ship, and other pages
		//        See enwiki:Boeing_757
		//
		//    - Split the expanded tokens into multiple lines.
		//    - Expanded attributes associated with the token are retained in the
		//      first line before a NlTk.
		//    - Content tokens after the NlTk are moved to subsequent lines.
		//    - The meta tags are hoisted before the original token to make sure
		//      that the entire token and following content is encapsulated as a unit.
		//
		// 2. We have a template that only generates multiple attributes of this
		//    token. In that case, we strip all template meta tags from the expanded
		//    tokens and assign it as mw:ExpandedAttrs type with orig/expanded
		//    values in data-mw.
		//
		// Reparse-KV-string scenario with templated attributes:
		// -----------------------------------------------------
		// In either scenario above, we need additional special handling if the
		// template generates one or more k=v style strings:
		//    <div {{echo|1=style='color:red''}}></div>
		//    <div {{echo|1=style='color:red' title='boo'}}></div>
		//
		// Real use case: Template {{ligne grise}} on frwp.
		//
		// To support this, we utilize the following hack. If we got a string of the
		// form "k=v" and our orig-v was "", we convert the token array to a string
		// and retokenize it to extract one or more attributes.
		//
		// But, we won't support scenarios like this:
		//   {| title={{echo|1='name' style='color:red;'\n|-\n|foo}}\n|}
		// Here, part of one attribute and additional complete attribute strings
		// need reparsing, and that isn't a use case that is worth more complexity here.
		//
		// FIXME:
		// ------
		// 1. It is not possible for multiple instances of scenario 1 to be triggered
		//    for the same token. So, I am not bothering trying to test and deal with it.
		//
		// 2. We trigger the Reparse-KV-string scenario only for attribute keys,
		//    since it isn't possible for attribute values to require this reparsing.
		//    However, it is possible to come up with scenarios where a template
		//    returns the value for one attribute and additional k=v strings for newer
		//    attributes. We don't support that scenario, but don't even test for it.
		//
		// Reparse-KV-string scenario with non-string attributes:
		// ------------------------------------------------------
		// This is only going to be the case with table wikitext that has special syntax
		// for attribute strings.
		//
		// {| <div>a</div> style='border:1px solid black;'
		// |- <div>b</div> style='border:1px dotted blue;'
		// | <div>c</div> style='color:red;'
		// |}
		//
		// In wikitext like the above, the PEG tokenizer doesn't recognize these as
		// valid attributes (the templated attribute scenario is a special case) and
		// orig-v will be "". So, the same strategy as above is applied here as well.

		var origK = expandedA.k;
		var origV = expandedA.v;
		var updatedK = null;
		var updatedV = null;
		var expandedK = expandedA.k;
		var reparsedKV = false;

		if (expandedK) {
			// FIXME: We should get rid of these array/string/non-string checks
			// and probably use appropriately-named flags to convey type information.
			if (Array.isArray(oldA.k)) {
				if (!(expandedK.constructor === String && /(^|\s)mw:maybeContent(\s|$)/.test(expandedK))) {
					nlTkPos = nlTkIndex(nlTkOkay, expandedK, wrapTemplates);
					if (nlTkPos !== -1) {
						// Scenario 1 from the documentation comment above.
						updatedK = splitTokens(env, token, nlTkPos, expandedK, wrapTemplates);
						expandedK = updatedK.preNLBuf;
						postNLToks = updatedK.postNLBuf;
						metaTokens = updatedK.metaTokens;
					} else {
						// Scenario 2 from the documentation comment above.
						updatedK = stripMetaTags(expandedK, wrapTemplates);
						expandedK = updatedK.value;
					}

					expandedA.k = expandedK;

					// Check if we need to deal with the Reparse-KV-string scenario.
					// (See documentation comment above)
					if (expandedA.v === '') {
						// Extract a parsable string from the token array.
						// Trim whitespace to ensure tokenizer isn't tripped up
						// by the presence of unnecessary whitespace.
						var kStr = Util.tokensToString(expandedK).trim();
						var rule = nlTkOkay ? 'generic_newline_attributes' : 'table_attributes';
						var kvs  = /=/.test(kStr) ? this.tokenizer.tokenizeSync(kStr, rule) : null;
						if (kvs) {
							// SSS FIXME: Collect all keys here, not just the first key
							// i.e. in a string like {{echo|1=id='v1' title='foo' style='..'}}
							// that string is setting attributes for [id, title, style], not just id.
							//
							// That requires the ability for the data-mw.attribs[i].txt to be an array.
							// However, the spec at [[mw:Parsoid/MediaWiki_DOM_spec]] says:
							//    "This spec also assumes that a template can only
							//     generate one attribute rather than multiple attributes."
							//
							// So, revision of the spec is another FIXME at which point this code can
							// be updated to reflect the revised spec.
							expandedK = kvs[0].k;
							reparsedKV = true;
							if (!newAttrs) {
								newAttrs = i === 0 ? [] : expandedAttrs.slice(0, i - 1);
							}
							newAttrs = newAttrs.concat(kvs);
						}
					}

					modified = true;
				}
			} else if (expandedK !== oldA.k) {
				modified = true;
			}

			// We have a potentially expanded value.
			// Check if the value came from a template/extension expansion.
			var attrValTokens = origV;
			if (expandedK.constructor === String && Array.isArray(oldA.v)) {
				if (!expandedK.match(/^mw:/)) {
					nlTkPos = nlTkIndex(nlTkOkay, attrValTokens, wrapTemplates);
					if (nlTkPos !== -1) {
						// Scenario 1 from the documentation comment above.
						updatedV = splitTokens(env, token, nlTkPos, attrValTokens, wrapTemplates);
						attrValTokens = updatedV.preNLBuf;
						postNLToks = updatedV.postNLBuf;
						metaTokens = updatedV.metaTokens;
					} else {
						// Scenario 2 from the documentation comment above.
						updatedV = stripMetaTags(attrValTokens, wrapTemplates);
						attrValTokens = updatedV.value;
					}
					expandedA.v = attrValTokens;
				}
				modified = true;
			} else if (attrValTokens !== oldA.v) {
				modified = true;
			}

			// Update data-mw to account for templated attributes.
			// For editability, set HTML property.
			//
			// If we encountered a reparse-KV-string scenario,
			// we set the value's HTML to [] since we can edit
			// the transclusion either via the key's HTML or the
			// value's HTML, but not both.
			if ((reparsedKV && (updatedK.hasGeneratedContent || metaTokens.length > 0)) ||
				(updatedK && updatedK.hasGeneratedContent) ||
				(updatedV && updatedV.hasGeneratedContent)) {
				var key = expandedK.constructor === String ? expandedK : Util.tokensToString(expandedK);
				if (!tmpDataMW) {
					tmpDataMW = new Map();
				}
				tmpDataMW.set(key, {
					k: {
						"txt": key,
						"html": reparsedKV || (updatedK && updatedK.hasGeneratedContent) ? origK : undefined,
					},
					v: {
						"html": reparsedKV ? [] : origV,
					},
				});
			}
		}

		// Update newAttrs
		if (newAttrs && !reparsedKV) {
			newAttrs.push(expandedA);
		}
	}

	if (modified) {
		token.attribs = newAttrs || expandedAttrs;

		// If the token already has an about, it already has transclusion/extension
		// wrapping. No need to record information about templated attributes in addition.
		//
		// FIXME: If there is a real use case for extension attributes getting
		// templated, this check can be relaxed to allow that.
		// https://gerrit.wikimedia.org/r/#/c/65575 has some reference code that
		// can be used then.

		if (!token.getAttribute('about') && tmpDataMW && tmpDataMW.size > 0) {
			cb({ async: true });

			// Flatten k-v pairs.
			var vals = [];
			tmpDataMW.forEach(function(obj) {
				vals.push(obj.k, obj.v);
			});

			var manager = this.manager;

			// Async-expand all token arrays to DOM.
			Util.expandValuesToDOM(manager.env, manager.frame, vals,
					wrapTemplates, function(err, eVals) {
				// FIXME: Do something with `err`?

				// Rebuild flattened k-v pairs.
				var expAttrs = [];
				for (var j = 0; j < eVals.length; j += 2) {
					expAttrs.push([eVals[j], eVals[j + 1]]);
				}

				// Mark token as having expanded attrs.
				token.addAttribute("about", manager.env.newAboutId());
				token.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
				token.addAttribute("data-mw", JSON.stringify({
					attribs: expAttrs,
				}));

				var newTokens = metaTokens.concat([token], postNLToks);
				if (metaTokens.length === 0) {
					// No more attribute expansion required for token after this
					newTokens.rank = skipRank;
				}

				cb({ tokens: newTokens });
			});

			return;
		}
		// console.warn("NEW TOK: " + JSON.stringify(token));
	}

	var newTokens = metaTokens.concat([token], postNLToks);
	if (metaTokens.length === 0) {
		// No more attribute expansion required for token after this
		newTokens.rank = skipRank;
	}

	cb({ tokens: newTokens });
};

if (typeof module === "object") {
	module.exports.AttributeExpander = AttributeExpander;
}
