/*
 * This file contains general utilities for token transforms.
 */
/* jshint nonstandard:true */ // define 'unescape'
'use strict';
require('../../core-upgrade.js');

var async = require('async');
var crypto = require('crypto');
var entities = require('entities');
var Consts = require('../config/WikitextConstants.js').WikitextConstants;
var JSUtils = require('./jsutils.js').JSUtils;
var Promise = require('./promise.js');

var request = Promise.promisify(require('request'), true);
var lastItem = JSUtils.lastItem;

// This is a circular dependency.  Don't use anything from defines at module
// evaluation time.  (For example, we can't define the usual local variable
// shortcuts here.)
var pd = require('../wt2html/parser.defines.js');
var DU;

/**
 * @class
 * @singleton
 */
var Util = {

	// Non-global and global versions of regexp for use everywhere
	COMMENT_REGEXP: /<!--(?:[^-]|-(?!->))*-->/,
	COMMENT_REGEXP_G: /<!--(?:[^-]|-(?!->))*-->/g,

	/**
	 * @method
	 *
	 * Set debugging flags on an object, based on an options object.
	 *
	 * @param {Object} parsoidConfig The config to modify.
	 * @param {Object} opts The options object to use for setting the debug flags.
	 * @return {Object} The modified object.
	 */
	setDebuggingFlags: function(parsoidConfig, opts) {
		// Handle the --help options
		var exit = false;
		if (opts.trace === 'help') {
			console.error(Util.traceUsageHelp());
			exit = true;
		}
		if (opts.dump === 'help') {
			console.error(Util.dumpUsageHelp());
			exit = true;
		}
		if (opts.debug === 'help') {
			console.error(Util.debugUsageHelp());
			exit = true;
		}
		if (exit) {
			process.exit(1);
		}

		// Ok, no help requested: process the options.
		if (opts.debug !== undefined) {
			// Continue to support generic debugging.
			if (opts.debug === true) {
				console.warn("Warning: Generic debugging, not handler-specific.");
				parsoidConfig.debug = Util.booleanOption(opts.debug);
			} else {
				// Setting --debug automatically enables --trace
				parsoidConfig.debugFlags = this.splitFlags(opts.debug);
				parsoidConfig.traceFlags = parsoidConfig.debugFlags;
			}
		}

		if (opts.trace !== undefined) {
			if (opts.trace === true) {
				console.warn("Warning: Generic tracing is no longer supported. Ignoring --trace flag. Please provide handler-specific tracing flags, e.g. '--trace pre,html5', to turn it on.");
			} else {
				// Add any new trace flags to the list of existing trace flags (if
				// any were inherited from debug); otherwise, create a new list.
				parsoidConfig.traceFlags = (parsoidConfig.traceFlags || []).concat(this.splitFlags(opts.trace));
			}
		}

		if (opts.dump !== undefined) {
			if (opts.dump === true) {
				console.warn("Warning: Generic dumping not enabled. Please set a flag.");
			} else {
				parsoidConfig.dumpFlags = this.splitFlags(opts.dump);
			}
		}

		return parsoidConfig;
	},


	/**
	 * @method
	 *
	 * Split a tracing / debugging flag string into individual flags
	 * and return them.
	 *
	 * @param {Object} origFlag The original flag string
	 * @return {Array}
	 */
	splitFlags: function(origFlag) {
		var objFlags = origFlag.split(",");
		if (objFlags.indexOf("selser") !== -1 && objFlags.indexOf("wts") === -1) {
			objFlags.push("wts");
		}
		return objFlags;
	},

	/**
	 * @method
	 *
	 * Returns a help message for the tracing flags.
	 */
	traceUsageHelp: function() {
		return [
			"Tracing",
			"-------",
			"- With one or more comma-separated flags, traces those specific phases",
			"- Supported flags:",
			"  * peg       : shows tokens emitted by tokenizer",
			"  * sync:1    : shows tokens flowing through the post-tokenizer Sync Token Transform Manager",
			"  * async:2   : shows tokens flowing through the Async Token Transform Manager",
			"  * sync:3    : shows tokens flowing through the post-expansion Sync Token Transform Manager",
			"  * tsp       : shows tokens flowing through the TokenStreamPatcher (useful to see in-order token stream)",
			"  * list      : shows actions of the list handler",
			"  * sanitizer : shows actions of the sanitizer",
			"  * pre       : shows actions of the pre handler",
			"  * p-wrap    : shows actions of the paragraph wrapper",
			"  * html      : shows tokens that are sent to the HTML tree builder",
			"  * dsr       : shows dsr computation on the DOM",
			"  * tplwrap   : traces template wrapping code (currently only range overlap/nest/merge code)",
			"  * wts       : trace actions of the regular wikitext serializer",
			"  * selser    : trace actions of the selective serializer",
			"  * domdiff   : trace actions of the DOM diffing code",
			"  * wt-escape : debug wikitext-escaping",
			"  * batcher   : trace API batch aggregation and dispatch",
			"  * apirequest: trace all API requests",
			"  * time      : trace times for various phases (right now, limited to DOMPP passes)",
			"  * time/dompp: trace times for DOM Post processing passes",
			"",
			"--debug enables tracing of all the above phases except Token Transform Managers",
			"",
			"Examples:",
			"$ node parse --trace pre,p-wrap,html < foo",
			"$ node parse --trace sync:3,dsr < foo",
		].join('\n');
	},

	/**
	 * @method
	 *
	 * Returns a help message for the dump flags.
	 */
	dumpUsageHelp: function() {
		return [
			"Dumping state",
			"-------------",
			"- Dumps state at different points of execution",
			"- DOM dumps are always doc.outerHTML",
			"- Supported flags:",
			"  * tplsrc            : dumps preprocessed template source that will be tokenized",
			"  * dom:post-builder  : dumps DOM returned by HTML builder",
			"  * dom:pre-dsr       : dumps DOM prior to computing DSR",
			"  * dom:post-dsr      : dumps DOM after computing DSR",
			"  * dom:pre-encap     : dumps DOM before template encapsulation",
			"  * dom:post-encap    : dumps DOM after template encapsulation",
			"  * dom:post-dom-diff : in selective serialization, dumps DOM after running dom diff",
			"  * dom:post-normal   : in serialization, dumps DOM after normalization",
			"  * wt2html:limits    : dumps used resources (along with configured limits)\n",
			"--debug dumps state at these different stages\n",
			"Examples:",
			"$ node parse --dump dom:post-builder,dom:pre-dsr,dom:pre-encap < foo",
			"$ node parse --trace html --dump dom:pre-encap < foo",
			"\n",
		].join('\n');
	},

	/**
	 * @method
	 *
	 * Returns a help message for the debug flags.
	 */
	debugUsageHelp: function() {
		return [
			"Debugging",
			"---------",
			"- With one or more comma-separated flags, provides more verbose tracing than the equivalent trace flag",
			"- Supported flags:",
			"  * pre       : shows actions of the pre handler",
			"  * wts       : trace actions of the regular wikitext serializer",
			"  * selser    : trace actions of the selective serializer",
		].join('\n');
	},

	/**
	 * @method
	 *
	 * Sets templating and processing flags on an object,
	 * based on an options object.
	 *
	 * @param {Object} parsoidConfig The config to modify.
	 * @param {Object} opts The options object to use for setting the debug flags.
	 * @return {Object} The modified object.
	 */
	setTemplatingAndProcessingFlags: function(parsoidConfig, opts) {
		[
			'fetchConfig',
			'fetchTemplates',
			'fetchImageInfo',
			'rtTestMode',
			'addHTMLTemplateParameters',
		].forEach(function(c) {
			if (opts[c] !== undefined) {
				parsoidConfig[c] = Util.booleanOption(opts[c]);
			}
		});
		if (opts.usephppreprocessor !== undefined) {
			parsoidConfig.usePHPPreProcessor = parsoidConfig.fetchTemplates &&
				Util.booleanOption(opts.usephppreprocessor);
		}
		if (opts.maxDepth !== undefined) {
			parsoidConfig.maxDepth = typeof (opts.maxdepth) === 'number' ?
				opts.maxdepth : parsoidConfig.maxDepth;
		}
		if (opts.apiURL) {
			parsoidConfig.setMwApi({ prefix: 'customwiki', uri: opts.apiURL });
		}
		if (opts.addHTMLTemplateParameters !== undefined) {
			parsoidConfig.addHTMLTemplateParameters =
				Util.booleanOption(opts.addHTMLTemplateParameters);
		}
		if (opts.lint) {
			parsoidConfig.linting = true;
			parsoidConfig.linterSendAPI = false;
		}
		if (opts.useBatchAPI !== null) {
			parsoidConfig.useBatchAPI = Util.booleanOption(opts.useBatchAPI);
		}
		return parsoidConfig;
	},

	/**
	 * @method
	 *
	 * Parse a boolean option returned by the yargs package.
	 * The strings 'false' and 'no' are also treated as false values.
	 * This allows --debug=no and --debug=false to mean the same as
	 * --no-debug.
	 *
	 * @param {boolean|string} val
	 *   a boolean, or a string naming a boolean value.
	 * @return {boolean}
	 */
	booleanOption: function(val) {
		if (!val) { return false; }
		if ((typeof val) === 'string' && /^(no|false)$/i.test(val)) {
			return false;
		}
		return true;
	},

	/**
	 * @method
	 *
	 * Set the color flags, based on an options object.
	 *
	 * @param {Object} options
	 *   The options object to use for setting the mode of the 'color' package.
	 * @param {String|Boolean} options.color
	 *   Whether to use color.  Passing 'auto' will enable color only if
	 *   stdout is a TTY device.
	 */
	setColorFlags: function(options) {
		var colors = require('colors');
		if (options.color === 'auto') {
			if (!process.stdout.isTTY) {
				colors.mode = 'none';
			}
		} else if (!Util.booleanOption(options.color)) {
			colors.mode = 'none';
		}
	},

	/**
	 * @method
	 *
	 * Add standard options to an yargs options hash.
	 * This handles options parsed by `setDebuggingFlags`,
	 * `setTemplatingAndProcessingFlags`, `setColorFlags`,
	 * and standard --help options.
	 *
	 * The `defaults` option is optional, and lets you override
	 * the defaults for the standard options.
	 */
	addStandardOptions: function(opts, defaults) {
		var standardOpts = {
			// standard CLI options
			'help': {
				description: 'Show this help message',
				'boolean': true,
				'default': false,
				alias: 'h',
			},
			// handled by `setDebuggingFlags`
			'debug': {
				description: 'Provide optional flags. Use --debug=help for supported options',
			},
			'trace': {
				description: 'Use --trace=help for supported options',
			},
			'dump': {
				description: 'Dump state. Use --dump=help for supported options',
			},
			// handled by `setTemplatingAndProcessingFlags`
			'fetchConfig': {
				description: 'Whether to fetch the wiki config from the server or use our local copy',
				'boolean': true,
				'default': true,
			},
			'fetchTemplates': {
				description: 'Whether to fetch included templates recursively',
				'boolean': true,
				'default': true,
			},
			'fetchImageInfo': {
				description: 'Whether to fetch image info via the API',
				'boolean': true,
				'default': true,
			},
			'usephppreprocessor': {
				description: 'Whether to use the PHP preprocessor to expand templates and extensions',
				'boolean': true,
				'default': true,
			},
			'addHTMLTemplateParameters': {
				description: 'Parse template parameters to HTML and add them to template data',
				'boolean': true,
				'default': false,
			},
			'maxdepth': {
				description: 'Maximum expansion depth',
				'default': 40,
			},
			'apiURL': {
				description: 'http path to remote API, e.g. http://en.wikipedia.org/w/api.php',
				'default': null,
			},
			'rtTestMode': {
				description: 'Test in rt test mode (changes some parse & serialization strategies)',
				'boolean': true,
				'default': false,
			},
			// handled by `setColorFlags`
			'color': {
				description: 'Enable color output Ex: --no-color',
				'default': 'auto',
			},
		};
		// allow overriding defaults
		Object.keys(defaults || {}).forEach(function(name) {
			if (standardOpts[name]) {
				standardOpts[name]['default'] = defaults[name];
			}
		});
		return Util.extendProps(opts, standardOpts);
	},

	/**
	 * @method
	 *
	 * Update only those properties that are undefined or null in the target.
	 *
	 * @param {Object} tgt The object to modify.
	 * @param {...Object} subject The object to extend tgt with. Add more arguments to the function call to chain more extensions.
	 * @return {Object} The modified object.
	 */
	extendProps: function(tgt) {
		function internalExtend(target, obj) {
			var allKeys = [].concat(Object.keys(target), Object.keys(obj));
			for (var i = 0, numKeys = allKeys.length; i < numKeys; i++) {
				var k = allKeys[i];
				if (target[k] === undefined || target[k] === null) {
					target[k] = obj[k];
				}
			}
			return target;
		}

		var n = arguments.length;
		for (var i = 1; i < n; i++) {
			internalExtend(tgt, arguments[i]);
		}
		return tgt;
	},

	stripParsoidIdPrefix: function(aboutId) {
		// 'mwt' is the prefix used for new ids in mediawiki.parser.environment#newObjectId
		return aboutId.replace(/^#?mwt/, '');
	},

	isParsoidObjectId: function(aboutId) {
		// 'mwt' is the prefix used for new ids in mediawiki.parser.environment#newObjectId
		return aboutId.match(/^#mwt/);
	},

	/**
	* Determine if a tag is block-level or not
	*/
	isBlockTag: function(name) {
		return Consts.HTML.BlockTags.has(name.toUpperCase());
	},

	/**
	 * In the PHP parser, these block tags open block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	 */
	tagOpensBlockScope: function(name) {
		return Consts.BlockScopeOpenTags.has(name.toUpperCase());
	},

	/**
	 * In the PHP parser, these block tags close block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	 */
	tagClosesBlockScope: function(name) {
		return Consts.BlockScopeCloseTags.has(name.toUpperCase());
	},

	/**
	 *Determine if the named tag is void (can not have content).
	 */
	isVoidElement: function(name) {
		return Consts.HTML.VoidTags.has(name.toUpperCase());
	},

	/**
	* Determine if a token is block-level or not
	*/
	isBlockToken: function(token) {
		if (token.constructor === pd.TagTk ||
				token.constructor === pd.EndTagTk ||
				token.constructor === pd.SelfclosingTagTk) {
			return Util.isBlockTag(token.name);
		} else {
			return false;
		}
	},

	isTemplateToken: function(token) {
		return token && token.constructor === pd.SelfclosingTagTk && token.name === 'template';
	},

	isTableTag: function(token) {
		var tc = token.constructor;
		return (tc === pd.TagTk || tc === pd.EndTagTk) &&
			Consts.HTML.TableTags.has(token.name.toUpperCase());
	},

	hasParsoidTypeOf: function(typeOf) {
		return (/(^|\s)mw:[^\s]+/).test(typeOf);
	},

	solTransparentLinkRegexp: /(?:^|\s)mw:PageProp\/(?:Category|redirect|Language)(?=$|\s)/,

	isSolTransparentLinkTag: function(token) {
		var tc = token.constructor;
		return (tc === pd.SelfclosingTagTk || tc === pd.TagTk || tc === pd.EndTagTk) &&
			token.name === 'link' &&
			this.solTransparentLinkRegexp.test(token.getAttribute('rel'));
	},

	isBehaviorSwitch: function(env, token) {
		return token.constructor === pd.SelfclosingTagTk && (
			// Before BehaviorSwitchHandler (ie. PreHandler, etc.)
			token.name === 'behavior-switch' ||
			// After BehaviorSwitchHandler
			// (ie. ListHandler, ParagraphWrapper, etc.)
			(token.name === 'meta' &&
				env.conf.wiki.bswPagePropRegexp.test(token.getAttribute('property')))
		);
	},

	// This should come close to matching DU.emitsSolTransparentSingleLineWT(),
	// without the single line caveat.
	isSolTransparent: function(env, token) {
		var tc = token.constructor;
		if (tc === String) {
			return token.match(/^\s*$/);
		} else if (this.isSolTransparentLinkTag(token)) {
			return true;
		} else if (tc === pd.CommentTk) {
			return true;
		} else if (this.isBehaviorSwitch(env, token)) {
			return true;
		} else if (tc !== pd.SelfclosingTagTk || token.name !== 'meta') {
			return false;
		} else {  // only metas left
			// Treat all mw:Extension/* tokens as non-SOL.
			if (/(?:^|\s)mw:Extension\//.test(token.getAttribute('typeof'))) {
				return false;
			} else {
				return token.dataAttribs.stx !== 'html';
			}
		}
	},

	isEmptyLineMetaToken: function(token) {
		return token.constructor === pd.SelfclosingTagTk &&
			token.name === "meta" &&
			token.getAttribute("typeof") === "mw:EmptyLine";
	},

	/*
	 * Transform "\n" and "\r\n" in the input string to NlTk tokens
	 */
	newlinesToNlTks: function(str, tsr0) {
		var toks = str.split(/\n|\r\n/);
		var ret = [];
		var tsr = tsr0;

		// Add one NlTk between each pair, hence toks.length-1
		for (var i = 0, n = toks.length - 1; i < n; i++) {
			ret.push(toks[i]);
			var nlTk = new pd.NlTk();
			if (tsr !== undefined) {
				tsr += toks[i].length;
				nlTk.dataAttribs = { tsr: [tsr, tsr + 1] };
			}
			ret.push(nlTk);
		}
		ret.push(toks[i]);

		return ret;
	},

	shiftTokenTSR: function(tokens, offset, clearIfUnknownOffset) {
		// Bail early if we can
		if (offset === 0) {
			return;
		}

		// offset should either be a valid number or null
		if (offset === undefined) {
			if (clearIfUnknownOffset) {
				offset = null;
			} else {
				return;
			}
		}

		// update/clear tsr
		for (var i = 0, n = tokens.length; i < n; i++) {
			var t = tokens[i];
			switch (t && t.constructor) {
				case pd.TagTk:
				case pd.SelfclosingTagTk:
				case pd.NlTk:
				case pd.CommentTk:
				case pd.EndTagTk:
					var da = tokens[i].dataAttribs;
					var tsr = da.tsr;
					if (tsr) {
						if (offset !== null) {
							da.tsr = [tsr[0] + offset, tsr[1] + offset];
						} else {
							da.tsr = null;
						}
					}

					// SSS FIXME: offset will always be available in
					// chunky-tokenizer mode in which case we wont have
					// buggy offsets below.  The null scenario is only
					// for when the token-stream-patcher attempts to
					// reparse a string -- it is likely to only patch up
					// small string fragments and the complicated use cases
					// below should not materialize.

					// target offset
					if (offset && da.targetOff) {
						da.targetOff += offset;
					}

					// content offsets for ext-links
					if (offset && da.contentOffsets) {
						da.contentOffsets[0] += offset;
						da.contentOffsets[1] += offset;
					}

					// end offset for pre-tag
					if (offset && da.endpos) {
						da.endpos += offset;
					}

					//  Process attributes
					if (t.attribs) {
						for (var j = 0, m = t.attribs.length; j < m; j++) {
							var a = t.attribs[j];
							if (Array.isArray(a.k)) {
								this.shiftTokenTSR(a.k, offset, clearIfUnknownOffset);
							}
							if (Array.isArray(a.v)) {
								this.shiftTokenTSR(a.v, offset, clearIfUnknownOffset);
							}

							// src offsets used to set mw:TemplateParams
							if (offset === null) {
								a.srcOffsets = null;
							} else if (a.srcOffsets) {
								for (var k = 0; k < a.srcOffsets.length; k++) {
									a.srcOffsets[k] += offset;
								}
							}
						}
					}
					break;

				default:
					break;
			}
		}
	},

	toStringTokens: function(tokens, indent) {
		if (!indent) {
			indent = "";
		}

		if (!Array.isArray(tokens)) {
			return [tokens.toString(false, indent)];
		} else if (tokens.length === 0) {
			return [null];
		} else {
			var buf = [];
			for (var i = 0, n = tokens.length; i < n; i++) {
				buf.push(tokens[i].toString(false, indent));
			}
			return buf;
		}
	},

	tokensToString: function(tokens, strict, stripEmptyLineMeta) {
		var out = '';
		// XXX: quick hack, track down non-array sources later!
		if (!Array.isArray(tokens)) {
			tokens = [ tokens ];
		}
		for (var i = 0, l = tokens.length; i < l; i++) {
			var token = tokens[i];
			if (!token) {
				continue;
			} else if (token.constructor === String) {
				out += token;
			} else if (token.constructor === pd.CommentTk ||
					token.constructor === pd.NlTk) {
				// strip comments and newlines
			} else if (stripEmptyLineMeta && this.isEmptyLineMetaToken(token)) {
				// If requested, strip empy line meta tokens too.
			} else if (strict) {
				// If strict, return accumulated string on encountering first non-text token
				return [out, tokens.slice(i)];
			} else if (Array.isArray(token)) {
				out += this.tokensToString(token, false, stripEmptyLineMeta);
			}
		}
		return out;
	},

	flattenAndAppendToks: function(array, prefix, t) {
		if (Array.isArray(t) || t.constructor === String) {
			if (t.length > 0) {
				if (prefix) {
					array.push(prefix);
				}
				array = array.concat(t);
			}
		} else {
			if (prefix) {
				array.push(prefix);
			}
			array.push(t);
		}

		return array;
	},

	// deep clones by default.
	clone: function(obj, deepClone) {
		if (deepClone === undefined) {
			deepClone = true;
		}
		if (Array.isArray(obj)) {
			if (deepClone) {
				return obj.map(function(el) {
					return Util.clone(el, true);
				});
			} else {
				return obj.slice();
			}
		} else if (obj instanceof Object && // only "plain objects"
					Object.getPrototypeOf(obj) === Object.prototype) {
			/* This definition of "plain object" comes from jquery,
			 * via zepto.js.  But this is really a big hack; we should
			 * probably put a console.assert() here and more precisely
			 * delimit what we think is legit to clone. (Hint: not
			 * tokens or DOM trees.) */
			if (deepClone) {
				return Object.keys(obj).reduce(function(nobj, key) {
					nobj[key] = Util.clone(obj[key], true);
					return nobj;
				}, {});
			} else {
				return Object.assign({}, obj);
			}
		} else {
			return obj;
		}
	},

	// 'cb' can only be called once after "everything" is done.
	// But, we need something that can be used in async context where it is
	// called repeatedly till we are done.
	//
	// Primarily needed in the context of async.map calls that requires a 1-shot callback.
	//
	// Use with caution!  If the async stream that we are accumulating into the buffer
	// is a firehose of tokens, the buffer will become huge.
	buildAsyncOutputBufferCB: function(cb) {
		function AsyncOutputBufferCB(cb2) {
			this.accum = [];
			this.targetCB = cb2;
		}

		AsyncOutputBufferCB.prototype.processAsyncOutput = function(res) {
			// * Ignore switch-to-async mode calls since
			//   we are actually collapsing async calls.
			// * Accumulate async call results in an array
			//   till we get the signal that we are all done
			// * Once we are done, pass everything to the target cb.
			if (res.async !== true) {
				// There are 3 kinds of callbacks:
				// 1. cb({tokens: .. })
				// 2. cb({}) ==> toks can be undefined
				// 3. cb(foo) -- which means in some cases foo can
				//    be one of the two cases above, or it can also be a simple string.
				//
				// Version 1. is the general case.
				// Versions 2. and 3. are optimized scenarios to eliminate
				// additional processing of tokens.
				//
				// In the C++ version, this is handled more cleanly.
				var toks = res.tokens;
				if (!toks && res.constructor === String) {
					toks = res;
				}

				if (toks) {
					if (Array.isArray(toks)) {
						for (var i = 0, l = toks.length; i < l; i++) {
							this.accum.push(toks[i]);
						}
						// this.accum = this.accum.concat(toks);
					} else {
						this.accum.push(toks);
					}
				}

				if (!res.async) {
					// we are done!
					this.targetCB(this.accum);
				}
			}
		};

		var r = new AsyncOutputBufferCB(cb);
		return r.processAsyncOutput.bind(r);
	},

	lookupKV: function(kvs, key) {
		if (!kvs) {
			return null;
		}
		var kv;
		for (var i = 0, l = kvs.length; i < l; i++) {
			kv = kvs[i];
			if (kv.k.constructor === String && kv.k.trim() === key) {
				// found, return it.
				return kv;
			}
		}
		// nothing found!
		return null;
	},

	lookup: function(kvs, key) {
		var kv = this.lookupKV(kvs, key);
		return kv === null ? null : kv.v;
	},

	lookupValue: function(kvs, key) {
		if (!kvs) {
			return null;
		}
		var kv;
		for (var i = 0, l = kvs.length; i < l; i++) {
			kv = kvs[i];
			if (kv.v === key) {
				// found, return it.
				return kv;
			}
		}
		// nothing found!
		return null;
	},

	/**
	 * Convert an array of key-value pairs into a hash of keys to values. For
	 * duplicate keys, the last entry wins.
	 */
	KVtoHash: function(kvs, convertValuesToString) {
		if (!kvs) {
			console.warn("Invalid kvs!: " + JSON.stringify(kvs, null, 2));
			return Object.create(null);
		}
		var res = Object.create(null);
		for (var i = 0, l = kvs.length; i < l; i++) {
			var kv = kvs[i];
			var key = this.tokensToString(kv.k).trim();
			// SSS FIXME: Temporary fix to handle extensions which use
			// entities in attribute values. We need more robust handling
			// of non-string template attribute values in general.
			var val = convertValuesToString ? this.tokensToString(kv.v) : kv.v;
			res[key.toLowerCase()] = this.tokenTrim(val);
		}
		return res;
	},

	/**
	 * Trim space and newlines from leading and trailing text tokens.
	 */
	tokenTrim: function(tokens) {
		if (!Array.isArray(tokens)) {
			return tokens;
		}

		// Since the tokens array might be frozen,
		// we have to create a new array -- but, create it
		// only if needed
		//
		// FIXME: If tokens is not frozen, we can avoid
		// all this circus with leadingToks and trailingToks
		// but we will need a new function altogether -- so,
		// something worth considering if this is a perf. problem.

		var i, token;
		var n = tokens.length;

		// strip leading space
		var leadingToks = [];
		for (i = 0; i < n; i++) {
			token = tokens[i];
			if (token.constructor === pd.NlTk) {
				leadingToks.push('');
			} else if (token.constructor === String) {
				leadingToks.push(token.replace(/^\s+/, ''));
				if (token !== '') {
					break;
				}
			} else {
				break;
			}
		}

		i = leadingToks.length;
		if (i > 0) {
			tokens = leadingToks.concat(tokens.slice(i));
		}

		// strip trailing space
		var trailingToks = [];
		for (i = n - 1; i >= 0; i--) {
			token = tokens[i];
			if (token.constructor === pd.NlTk) {
				trailingToks.push(''); // replace newline with empty
			} else if (token.constructor === String) {
				trailingToks.push(token.replace(/\s+$/, ''));
				if (token !== '') {
					break;
				}
			} else {
				break;
			}
		}

		var j = trailingToks.length;
		if (j > 0) {
			tokens = tokens.slice(0, n - j).concat(trailingToks.reverse());
		}

		return tokens;
	},

	// Strip EOFTk token from token chunk
	stripEOFTkfromTokens: function(tokens) {
		// this.dp( 'stripping end or whitespace tokens' );
		if (!Array.isArray(tokens)) {
			tokens = [ tokens ];
		}
		if (!tokens.length) {
			return tokens;
		}
		// Strip 'end' token
		if (tokens.length && lastItem(tokens).constructor === pd.EOFTk) {
			var rank = tokens.rank;
			tokens = tokens.slice(0, -1);
			tokens.rank = rank;
		}

		return tokens;
	},

	// Strip NlTk and ws-only trailing text tokens. Used to be part of
	// stripEOFTkfromTokens, but unclear if this is still needed.
	// TODO: remove this if this is not needed any more!
	stripTrailingNewlinesFromTokens: function(tokens) {
		var token = lastItem(tokens);
		var lastMatches = function(toks) {
			var lastTok = lastItem(toks);
			return lastTok && (
					lastTok.constructor === pd.NlTk ||
					lastTok.constructor === String && /^\s+$/.test(token));
		};
		if (lastMatches) {
			tokens = tokens.slice();
		}
		while (lastMatches) {
			tokens.pop();
		}
		return tokens;
	},

	/**
	 * Creates a dom-fragment-token for processing 'content' (an array of tokens)
	 * in its own subpipeline all the way to DOM. These tokens will be processed
	 * by their own handler (DOMFragmentBuilder) in the last stage of the async
	 * pipeline.
	 *
	 * srcOffsets should always be provided to process top-level page content in a
	 * subpipeline. Without it, DSR computation and template wrapping cannot be done
	 * in the subpipeline. While unpackDOMFragment can do this on unwrapping, that can
	 * be a bit fragile and makes dom-fragments a leaky abstraction by leaking subpipeline
	 * processing into the top-level pipeline.
	 *
	 * @param {Token[]} content
	 *   The array of tokens to process
	 * @param {Number[]} srcOffsets
	 *   Wikitext source offsets (start/end) of these tokens
	 * @param {Object} [opts]
	 *   Parsing options
	 * @param {Token} opts.contextTok
	 *   The token that generated the content
	 * @param {Boolean} opts.noPre
	 *   Suppress indent-pres in content
	 */
	getDOMFragmentToken: function(content, srcOffsets, opts) {
		if (!opts) {
			opts = {};
		}

		return new pd.SelfclosingTagTk('mw:dom-fragment-token', [
			new pd.KV('contextTok', opts.token),
			new pd.KV('content', content),
			new pd.KV('noPre',  opts.noPre || false),
			new pd.KV('noPWrapping',  opts.noPWrapping || false),
			new pd.KV('srcOffsets', srcOffsets),
		]);
	},

	// Does this need separate UI/content inputs?
	formatNum: function(num) {
		return num + '';
	},

	// php's urlencode
	urlencode: function(txt) {
		return encodeURIComponent(txt).replace(/%20/g, '+');
	},

	decodeURI: function(s) {
		return s.replace(/(%[0-9a-fA-F][0-9a-fA-F])+/g, function(m) {
			try {
				// JS library function
				return decodeURIComponent(m);
			} catch (e) {
				return m;
			}
		});
	},

	sanitizeTitleURI: function(title) {
		var bits = title.split('#');
		var anchor = null;
		var sanitize = function(s) {
			return s.replace(/[%? \[\]#|<>]/g, function(m) {
				return encodeURIComponent(m);
			});
		};
		if (bits.length > 1) { // split at first '#'
			anchor = title.substring(bits[0].length + 1);
			title = bits[0];
		}
		title = sanitize(title);
		if (anchor !== null) {
			title += '#' + sanitize(anchor);
		}
		return title;
	},

	sanitizeURI: function(s) {
		var host = s.match(/^[a-zA-Z]+:\/\/[^\/]+(?:\/|$)/);
		var path = s;
		var anchor = null;
		if (host) {
			path = s.substr(host[0].length);
			host = host[0];
		} else {
			host = '';
		}
		var bits = path.split('#');
		if (bits.length > 1) {
			anchor = lastItem(bits);
			path = path.substr(0, path.length - anchor.length - 1);
		}
		host = host.replace(/[%#|]/g, function(m) {
			return encodeURIComponent(m);
		});
		path = path.replace(/[% \[\]#|]/g, function(m) {
			return encodeURIComponent(m);
		});
		s = host + path;
		if (anchor !== null) {
			s += '#' + anchor;
		}
		return s;
	},

	/**
	 * Strip a string suffix if it matches
	 */
	stripSuffix: function(text, suffix) {
		var sLen = suffix.length;
		if (sLen && text.substr(-sLen) === suffix) {
			return text.substr(0, text.length - sLen);
		} else {
			return text;
		}
	},

	/**
	 * Processes content (wikitext, array of tokens, whatever) in its own pipeline
	 * based on options.
	 *
	 * @param {Object} env
	 *    The environment/context for the expansion.
	 *
	 * @param {Object} frame
	 *    The parent frame within which the expansion is taking place.
	 *    This param is mostly defunct now that we are not doing native
	 *    expansion anymore.
	 *
	 * @param {Object} content
	 *    This could be wikitext or single token or an array of tokens.
	 *    How this content is processed depends on what kind of pipeline
	 *    is constructed specified by opts.
	 *
	 * @param {Object} opts
	 *    Processing options that specify pipeline-type, opts, and callbacks.
	 */
	processContentInPipeline: function(env, frame, content, opts) {
		// Build a pipeline
		var pipeline = env.pipelineFactory.getPipeline(
			opts.pipelineType,
			opts.pipelineOpts
		);

		// Set frame if necessary
		if (opts.tplArgs) {
			pipeline.setFrame(frame, opts.tplArgs.name, opts.tplArgs.attribs);
		}

		// Set source offsets for this pipeline's content
		if (opts.srcOffsets) {
			pipeline.setSourceOffsets(opts.srcOffsets[0], opts.srcOffsets[1]);
		}

		// Set up provided callbacks
		if (opts.chunkCB) {
			pipeline.addListener('chunk', opts.chunkCB);
		}
		if (opts.endCB) {
			pipeline.addListener('end', opts.endCB);
		}
		if (opts.documentCB) {
			pipeline.addListener('document', opts.documentCB);
		}

		// Off the starting block ... ready, set, go!
		pipeline.process(content, opts.tplArgs ? opts.tplArgs.cacheKey : undefined);
	},

	/**
	 * A promise returning wrapper around processContentInPipeline that
	 * resolves with the docuemnt.
	 */
	promiseToProcessContent: function(env, frame, content, opts, cb) {
		cb = JSUtils.mkPromised(cb);
		Util.processContentInPipeline(env, frame, content, {
			pipelineType: opts.pipelineType,
			pipelineOpts: opts.pipelineOpts,
			srcOffsets: opts ? opts.srcOffsets : undefined,
			// processContentInPipeline has no error callback :(
			documentCB: function(dom) { cb(null, dom); },
		});
		return cb.promise;
	},

	/**
	 * Expands values all the way to DOM and passes them back to a callback
	 *
	 * @param {Object} env
	 *    The environment/context for the expansion.
	 *
	 * @param {Object} frame
	 *    The parent frame within which the expansion is taking place.
	 *    This param is mostly defunct now that we are not doing native
	 *    expansion anymore.
	 *
	 * @param {Object[]} vals
	 *    The array of values to process.
	 *    Each value of this array is expected to be an object with a "html" property.
	 *    The html property is expanded to DOM only if it is an array (of tokens).
	 *    Non-arrays are passed back unexpanded.
	 *
	 * @param {boolean} wrapTemplates
	 *    Should any templates encountered here be marked up?
	 *    (usually false for nested templates since they are never directly editable).
	 *
	 * @param {Function} finalCB
	 *    The callback to pass the expanded values into.
	 *
	 * FIXME: This could be generified a bit more.
	 */
	expandValuesToDOM: function(env, frame, vals, wrapTemplates, finalCB) {
		if (!DU) { DU = require('./DOMUtils.js').DOMUtils; }
		async.map(vals, function(v, cb) {
			if (Array.isArray(v.html)) {
				// Set up pipeline options
				var opts = {
					pipelineType: 'tokens/x-mediawiki/expanded',
					pipelineOpts: {
						attrExpansion: true,
						noPWrapping: true,
						noPre: true,
						wrapTemplates: wrapTemplates,
					},
				};
				var content = v.html.concat([new pd.EOFTk()]);
				Util.promiseToProcessContent(env, frame, content, opts)
				.then(function(dom) {
					// Since we aren't at the top level, data attrs
					// were not applied in cleanup.  However, tmp
					// was stripped.
					v.html = DU.ppToXML(dom.body, { innerXML: true });
					return v;
				})
				.catch(function(err) {
					env.log('error', 'Expanding values to DOM', err);
					return v;
				})
				.nodify(cb);
			} else {
				cb(null, v);
			}
		}, finalCB);
	},

	extractExtBody: function(token) {
		var src = token.getAttribute('source');
		var tagWidths = token.dataAttribs.tagWidths;
		return src.substring(tagWidths[0], src.length - tagWidths[1]);
	},

	// Returns the utf8 encoding of the code point
	codepointToUtf8: function(cp) {
		try {
			return String.fromCharCode(cp);
		} catch (e) {
			// Return a tofu?
			return cp.toString();
		}
	},

	// Returns true if a given Unicode codepoint is a valid character in XML.
	validateCodepoint: function(cp) {
		return (cp ===    0x09) ||
			(cp ===   0x0a) ||
			(cp ===   0x0d) ||
			(cp >=    0x20 && cp <=   0xd7ff) ||
			(cp >=  0xe000 && cp <=   0xfffd) ||
			(cp >= 0x10000 && cp <= 0x10ffff);
	},

	isValidDSR: function(dsr) {
		return dsr &&
			typeof (dsr[0]) === 'number' && dsr[0] >= 0 &&
			typeof (dsr[1]) === 'number' && dsr[1] >= 0;
	},

	/**
	 * Quickly hash an array or string.
	 *
	 * @param {Array/string} arr
	 */
	makeHash: function(arr) {
		var md5 = crypto.createHash('MD5');
		var i;
		if (Array.isArray(arr)) {
			for (i = 0; i < arr.length; i++) {
				if (arr[i] instanceof String) {
					md5.update(arr[i]);
				} else {
					md5.update(arr[i].toString());
				}
				md5.update("\0");
			}
		} else {
			md5.update(arr);
		}
		return md5.digest('hex');
	},

	/**
	 * Determine whether the current token was an HTML tag in wikitext.
	 *
	 * @return {boolean}
	 */
	isHTMLTag: function(token) {
		switch (token.constructor) {
			case String:
			case pd.NlTk:
			case pd.CommentTk:
			case pd.EOFTk:
				return false;
			case pd.TagTk:
			case pd.EndTagTk:
			case pd.SelfclosingTagTk:
				return token.dataAttribs.stx === 'html';
			default:
				console.assert(false, 'Unhandled token type');
		}
	},
};

/**
 * @property linkTrailRegex
 *
 * This regex was generated by running through *all unicode characters* and
 * testing them against *all regexes* for linktrails in a default MW install.
 * We had to treat it a little bit, here's what we changed:
 *
 * 1. A-Z, though allowed in Walloon, is disallowed.
 * 2. '"', though allowed in Chuvash, is disallowed.
 * 3. '-', though allowed in Icelandic (possibly due to a bug), is disallowed.
 * 4. '1', though allowed in Lak (possibly due to a bug), is disallowed.
 */
Util.linkTrailRegex = new RegExp(
	'^[^\0-`{÷ĀĈ-ČĎĐĒĔĖĚĜĝĠ-ĪĬ-įĲĴ-ĹĻ-ĽĿŀŅņŉŊŌŎŏŒŔŖ-ŘŜŝŠŤŦŨŪ-ŬŮŲ-ŴŶŸ' +
	'ſ-ǤǦǨǪ-Ǯǰ-ȗȜ-ȞȠ-ɘɚ-ʑʓ-ʸʽ-̂̄-΅·΋΍΢Ϗ-ЯѐѝѠѢѤѦѨѪѬѮѰѲѴѶѸѺ-ѾҀ-҃҅-ҐҒҔҕҘҚҜ-ҠҤ-ҪҬҭҰҲ' +
	'Ҵ-ҶҸҹҼ-ҿӁ-ӗӚ-ӜӞӠ-ӢӤӦӪ-ӲӴӶ-ՠֈ-׏׫-ؠً-ٳٵ-ٽٿ-څڇ-ڗڙ-ڨڪ-ڬڮڰ-ڽڿ-ۅۈ-ۊۍ-۔ۖ-਀਄਋-਎਑਒' +
	'਩਱਴਷਺਻਽੃-੆੉੊੎-੘੝੟-੯ੴ-჏ჱ-ẼẾ-​\u200d-‒—-‗‚‛”--\ufffd\ufffd]+$');

/**
 * @method
 *
 * Check whether some text is a valid link trail.
 *
 * @param {string} text
 * @return {boolean}
 */
Util.isLinkTrail = function(text) {
	if (text && text.match && text.match(this.linkTrailRegex)) {
		return true;
	} else {
		return false;
	}
};

/**
 * @method
 *
 * Cannonicalizes a namespace name.
 *
 * Used by WikiConfig.
 *
 * @param {string} name non-normalized namespace name
 * @return {string}
 */
Util.normalizeNamespaceName = function(name) {
	return name.toLowerCase().replace(' ', '_');
};


/**
 * @method
 *
 * Decode HTML5 entities in text.
 *
 * @param {string} text
 * @return {string}
 */
Util.decodeEntities = function(text) {
	return entities.decodeHTML5(text);
};


/**
 * @method
 *
 * Entity-escape anything that would decode to a valid HTML entity
 *
 * @param {string} text
 * @return {string}
 */
Util.escapeEntities = function(text) {
	// [CSA] replace with entities.encode( text, 2 )?
	// but that would encode *all* ampersands, where we apparently just want
	// to encode ampersands that precede valid entities.
	return text.replace(/&[#0-9a-zA-Z]+;/g, function(match) {
		var decodedChar = Util.decodeEntities(match);
		if (decodedChar !== match) {
			// Escape the and
			return '&amp;' + match.substr(1);
		} else {
			// Not an entity, just return the string
			return match;
		}
	});
};

/** Encode all characters as entity references.  This is done to make
 *  characters safe for wikitext (regardless of whether they are
 *  HTML-safe). */
Util.entityEncodeAll = function(s) {
	// this is surrogate-aware
	return Array.from(s).map(function(c) {
		c = c.codePointAt(0).toString(16).toUpperCase();
		if (c.length === 1) { c = '0' + c; } // convention
		if (c === 'A0') { return '&nbsp;'; } // special-case common usage
		return '&#x' + c + ';';
	}).join('');
};

Util.isHTMLElementName = function(name) {
	name = name.toUpperCase();
	return Consts.HTML.HTML5Tags.has(name) || Consts.HTML.OlderHTMLTags.has(name);
};

/**
 * Determine whether the protocol of a link is potentially valid. Use the
 * environment's per-wiki config to do so.
 */
Util.isProtocolValid = function(linkTarget, env) {
	var wikiConf = env.conf.wiki;
	if (typeof linkTarget === 'string') {
		return wikiConf.hasValidProtocol(linkTarget);
	} else {
		return true;
	}
};

/**
 * Escape special regexp characters in a string used to build a regexp
 */
Util.escapeRegExp = function(s) {
	return s.replace(/[\^\\$*+?.()|{}\[\]\/]/g, '\\$&');
};

/**
 * Perform a HTTP request using the 'request' package, and retry on failures
 * Only use on idempotent HTTP end points
 *
 * @param {Number} retries The number of retries to attempt.
 * @param {Object} requestOptions Request options.
 * @param {Number} [delay] Exponential back-off.
 * @return {Promise}
 */
Util.retryingHTTPRequest = function(retries, requestOptions, delay) {
	delay = delay || 100;  // start with 100ms
	return request(requestOptions)
	.catch(function(error) {
		if (retries--) {
			console.error('HTTP ' + requestOptions.method + ' to \n' +
					(requestOptions.uri || requestOptions.url) + ' failed: ' + error +
					'\nRetrying in ' + (delay / 1000) + ' seconds.');
			return Promise.delay(delay).then(function() {
				return Util.retryingHTTPRequest(retries, requestOptions, delay * 2);
			});
		} else {
			return Promise.reject(error);
		}
	})
	.spread(function(res, body) {
		if (res.statusCode !== 200) {
			throw new Error('Got status code: ' + res.statusCode +
				'; body: ' + body);
		}
		return Array.from(arguments);
	});
};

/* Magic words masquerading as templates. */
Util.magicMasqs = new Set(["defaultsort", "displaytitle"]);

// Helper function to process extension source
Util.processExtSource = function(manager, extToken, opts) {
	var extBody = Util.extractExtBody(extToken);
	var tagWidths = extToken.dataAttribs.tagWidths;

	// FIXME: Should this be specific to the extension
	// Or is it okay to do this unconditionally for all?
	// Right now, this code is run only for ref and references,
	// so not a real problem, but if this is used on other extensions,
	// requires addressing.
	//
	// FIXME: SSS: This stripping maybe be unnecessary after all.
	//
	// Strip all leading white-space
	var wsMatch = extBody.match(/^(\s*)([^]*)$/);
	var leadingWS = wsMatch[1];

	// Update content to normalized form
	var content = wsMatch[2];

	if (!content || content.length === 0) {
		opts.emptyContentCB(opts.res);
	} else {
		// Pass an async signal since the ext-content is not processed completely.
		opts.parentCB({ tokens: opts.res, async: true });

		// Wrap templates always
		opts.pipelineOpts = Util.extendProps({}, opts.pipelineOpts, { wrapTemplates: true });

		var tsr = extToken.dataAttribs.tsr;
		opts.srcOffsets = [ tsr[0] + tagWidths[0] + leadingWS.length, tsr[1] - tagWidths[1] ];

		// Process ref content
		Util.processContentInPipeline(manager.env, manager.frame, content, opts);
	}
};

Util.getArgInfo = function(extToken) {
	var name = extToken.getAttribute('name');
	var options = extToken.getAttribute('options');
	return {
		dict: {
			name: name,
			attrs: Util.KVtoHash(options, true),
			body: { extsrc: Util.extractExtBody(extToken) },
		},
	};
};

Util.placeholder = function(content, dataAttribs, endAttribs) {
	if (content === null) {
		return [
			new pd.SelfclosingTagTk('meta', [
				new pd.KV('typeof', 'mw:Placeholder'),
			], dataAttribs),
		];
	} else {
		return [
			new pd.TagTk('span', [
				new pd.KV('typeof', 'mw:Placeholder'),
			], dataAttribs),
			content,
			new pd.EndTagTk('span', [], endAttribs),
		];
	}
};


if (typeof module === "object") {
	module.exports.Util = Util;
}
