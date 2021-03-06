'use strict';
require('../../core-upgrade.js');

var domino = require('domino');
var events = require('events');
var request = require('request');
var util = require('util');
var semver = require('semver');

var Promise = require('../utils/promise.js');


function setupConnectionTimeout(env, protocol) {
	var http = require(protocol);
	var Agent = http.Agent;

	function ConnectTimeoutAgent() {
		Agent.apply(this, arguments);
	}
	util.inherits(ConnectTimeoutAgent, Agent);

	ConnectTimeoutAgent.prototype.createSocket = function() {
		var args = Array.from(arguments);
		var options = this.options;
		var cb = null;
		function setup(err, s) {
			if (err) {
				if (typeof cb === 'function') {
					cb(err, s);
				}
				return;
			}
			// Set up a connect timeout if connectTimeout option is set
			if (options.connectTimeout && !s.connectTimeoutTimer) {
				s.connectTimeoutTimer = setTimeout(function() {
					var e = new Error('ETIMEDOUT');
					e.code = 'ETIMEDOUT';
					s.end();
					s.emit('error', e);
					s.destroy();
				}, options.connectTimeout);
				s.once('connect',  function() {
					if (s.connectTimeoutTimer) {
						clearTimeout(s.connectTimeoutTimer);
						s.connectTimeoutTimer = undefined;
					}
				});
			}
			if (typeof cb === 'function') {
				cb(null, s);
			}
		}
		// Unfortunately, `createSocket` is not a public method of Agent
		// and, in v5.7 of node, it switched to being an asynchronous method.
		// `setup` is passed in to remain compatible going forward, while
		// we continue to return the socket if the synchronous method is
		// feature detected.
		var sufficientNodeVersion = semver.gte(process.version, '5.7.0');
		if (sufficientNodeVersion) {
			cb = args[2];
			args[2] = setup;
		}
		var sock = Agent.prototype.createSocket.apply(this, args);
		if (!sufficientNodeVersion) {
			setup(null, sock);
			return sock;
		}
	};

	return new ConnectTimeoutAgent({
		connectTimeout: env.conf.parsoid.timeouts.mwApi.connect,
		maxSockets: env.conf.parsoid.maxSockets,
	});
}

var latestSerial = 0;

// all revision properties which parsoid is interested in.
var PARSOID_RVPROP = ('content|ids|timestamp|user|userid|size|sha1|contentmodel|comment');

var logAPIWarnings = function(req, data) {
	if (req.env.conf.parsoid.logMwApiWarnings &&
			data && data.hasOwnProperty('warnings')) {
		// split up warnings by API module
		Object.keys(data.warnings).forEach(function(apiModule) {
			var re = req.env.conf.parsoid.suppressMwApiWarnings;
			var msg = data.warnings[apiModule]['*'];
			if (re instanceof RegExp && re.test(msg)) {
				return; // suppress this message
			}
			req.env.log('warning/api/' + apiModule, req.reqType, msg);
		});
	}
};

// Helper to return a promise returning function for the result of an
// (Ctor-type) ApiRequest.
var promiseFor = function(Ctor) {
	return function() {
		var args = Array.prototype.slice.call(arguments);
		return new Promise(function(resolve, reject) {
			var req = Object.create(Ctor.prototype);
			Ctor.apply(req, args);
			req.once('src', function(err, src) {
				if (err) {
					reject(err);
				} else {
					resolve(src);
				}
			});
		});
	};
};

var manglePreprocessorResponse = function(env, response) {
	var src = '';
	if (response.wikitext !== undefined) {
		src = response.wikitext;
	} else if (response["*"] !== undefined) {
		// For backwards compatibility. Older wikis still put the data here.
		src = response["*"];
	} else {
		env.log('warning/api', "Invalid API preprocessor response");
	}

	// Add the categories which were added by parser functions directly
	// into the page and not as in-text links.
	if (Array.isArray(response.categories)) {
		for (var i in response.categories) {
			var category = response.categories[i];
			src += '\n[[Category:' + category['*'];
			if (category.sortkey) {
				src += "|" + category.sortkey;
			}
			src += ']]';
		}
	}
	// Ditto for page properties (like DISPLAYTITLE and DEFAULTSORT)
	if (Array.isArray(response.properties)) {
		response.properties.forEach(function(prop) {
			if (prop.name === 'displaytitle' || prop.name === 'defaultsort') {
				src += '\n{{' + prop.name.toUpperCase() + ':' + prop['*'] + '}}';
			}
		});
	}
	// The same for ResourceLoader modules
	env.setPageProperty(response.modules, "extensionModules");
	env.setPageProperty(response.modulescripts, "extensionModuleScripts");
	env.setPageProperty(response.modulestyles, "extensionModuleStyles");

	return src;
};

var dummyDoc = domino.createDocument();
var mangleParserResponse = function(env, response) {
	var parsedHtml = '';
	if (typeof response.text === "string") {
		parsedHtml = response.text;
	} else if (response.text['*'] !== undefined) {
		parsedHtml = response.text['*'];
	} else {
		env.log('warning/api', "Invalid API parser response");
	}
	// Strip two trailing newlines that action=parse adds after any
	// extension output
	parsedHtml = parsedHtml.replace(/\n\n$/, '');

	// Also strip a paragraph wrapper, if any
	parsedHtml = parsedHtml.replace(/(^<p>)|(<\/p>$)/g, '');

	// Add the modules to the page data
	env.setPageProperty(response.modules, "extensionModules");
	env.setPageProperty(response.modulescripts, "extensionModuleScripts");
	env.setPageProperty(response.modulestyles, "extensionModuleStyles");

	// Add the categories which were added by extensions directly into the
	// page and not as in-text links
	if (response.categories) {
		for (var i in response.categories) {
			var category = response.categories[i];

			var link = dummyDoc.createElement("link");
			link.setAttribute("rel", "mw:PageProp/Category");

			var href = env.page.relativeLinkPrefix + "Category:" + encodeURIComponent(category['*']);
			if (category.sortkey) {
				href += "#" + encodeURIComponent(category.sortkey);
			}
			link.setAttribute("href", href);

			parsedHtml += "\n" + link.outerHTML;
		}
	}

	return parsedHtml;
};

/**
 * @class
 * @extends Error
 */
function DoesNotExistError(message) {
	Error.captureStackTrace(this, DoesNotExistError);
	this.name = "DoesNotExistError";
	this.message = message || "Something doesn't exist";
	this.httpStatus = 404;
	this.suppressLoggingStack = true;
}
DoesNotExistError.prototype = Error.prototype;

/**
 * @class
 * @extends Error
 */
function ParserError(message) {
	Error.captureStackTrace(this, ParserError);
	this.name = "ParserError";
	this.message = message || "Generic parser error";
	this.httpStatus = 500;
}
ParserError.prototype = Error.prototype;

/**
 * @class
 * @extends Error
 */
function AccessDeniedError(message) {
	Error.captureStackTrace(this, AccessDeniedError);
	this.name = 'AccessDeniedError';
	this.message = message || 'Your wiki requires a logged-in account to access the API.';
	this.httpStatus = 401;
}
AccessDeniedError.prototype = Error.prototype;

/**
 *
 * Abstract API request base class
 *
 * @class
 * @extends EventEmitter
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} title The title of the page we should fetch from the API
 */
function ApiRequest(env, title) {
	// call the EventEmitter constructor
	events.EventEmitter.call(this);

	// Update the number of maximum listeners
	this.setMaxListeners(env.conf.parsoid.maxListeners);

	this.retries = env.conf.parsoid.retries.mwApi.all;
	this.env = env;
	this.title = title;
	this.queueKey = title;
	this.serial = ++latestSerial;
	this.reqType = "Page Fetch";

	// Proxy to the MW API. Set to null for subclasses going somewhere else.
	this.proxy = env.conf.wiki.apiProxy;
}

// Inherit from EventEmitter
util.inherits(ApiRequest, events.EventEmitter);

var httpAgent = null;
var httpsAgent = null;

ApiRequest.prototype.request = function(options, callback) {
	var env = this.env;
	var proxy = this.proxy;

	// this is a good place to put debugging statements
	// if you want to watch network requests.
	// console.log('ApiRequest', options);

	if (httpAgent === null) {
		httpAgent = setupConnectionTimeout(env, 'http');
		httpsAgent = setupConnectionTimeout(env, 'https');
	}
	options.agent = /^https[:]/.test(options.uri) ? httpsAgent : httpAgent;

	// Forward the request id
	if (!options.headers) { options.headers = {}; }
	options.headers['X-Request-ID'] = env.reqId;
	// Set default options, forward cookie if set.
	options.headers['User-Agent'] = env.conf.parsoid.userAgent;
	options.headers.Connection = 'close';
	options.strictSSL = env.conf.parsoid.strictSSL;
	if (env.cookie) {
		options.headers.Cookie = env.cookie;
	}
	// Proxy options should only be applied to MW API endpoints.
	// Allow subclasses to manually set proxy to `null` or to a different
	// proxy to override MW API proxy.
	if (proxy && proxy.uri && options.proxy === undefined) {
		options.proxy = proxy.uri;
		options.agent = /^https[:]/.test(proxy.uri) ? httpsAgent : httpAgent;
		if (proxy.headers) {
			Object.assign(options.headers, proxy.headers);
		}
		if (proxy.strip_https && /^https[:]/.test(options.uri)) {
			// When proxying, strip TLS and lie to the appserver to indicate
			// unwrapping has just occurred. The appserver isn't listening on
			// port 443 but a site setting may require a secure connection,
			// which the header identifies.  (This is primarily for proxies
			// used in WMF production, for which initMwApiMap sets the
			// proxy.strip_https flag.)
			options.uri = options.uri.replace(/^https/, 'http');
			options.headers['X-Forwarded-Proto'] = 'https';
		}
	}
	this.trace("Starting HTTP request: ", options);

	return request(options, callback);
};

/**
 * @method
 * @private
 * @param {Object} data API response body
 * @param {string} requestStr request string -- useful to help debug what went wrong
 * @param {string} defaultMsg default error message if there were no data.error property
 */
ApiRequest.prototype._errorObj = function(data, requestStr, defaultMsg) {
	return new Error('API response Error for ' +
		this.constructor.name + ': request=' +
		(requestStr || '') + "; error=" +
		JSON.stringify((data && data.error) || defaultMsg));
};

/**
 * @method
 * @private
 * @param {Error|null} error
 * @param {string} data wikitext / html / metadata
 */
ApiRequest.prototype._processListeners = function(error, data) {
	// Process only a few callbacks in each event loop iteration to
	// reduce memory usage.
	var self = this;
	var processSome = function() {
		// listeners() returns a copy (slice) of the listeners array in
		// 0.10. Get a new copy including new additions before processing
		// each batch.
		var listeners = self.listeners('src');
		// XXX: experiment a bit with the number of callbacks per
		// iteration!
		var maxIters = Math.min(1, listeners.length);
		for (var it = 0; it < maxIters; it++) {
			var nextListener = listeners.shift();
			self.removeListener('src', nextListener);

			// We only retrieve text/x-mediawiki source currently.
			// We expect these listeners to remove themselves when being
			// called - always add them with once().
			try {
				nextListener.call(self, error || null, data, 'text/x-mediawiki');
			} catch (e) {
				return self.env.log('fatal', e);
			}
		}
		if (listeners.length) {
			setImmediate(processSome);
		}
	};
	setImmediate(processSome);
};

/**
 * @method
 * @private
 * @param {Error|null} error
 * @param {Object} response The API response object, with error code
 * @param {string} body The body of the response from the API
 */
ApiRequest.prototype._requestCB = function(error, response, body) {
	if (error) {
		this.trace("Received error:", error);
		this.env.log('warning/api' + (error.code ? ("/" + error.code).toLowerCase() : ''),
			'Failed API request,', {
				"error": error,
				"status": response && response.statusCode,
				"retries-remaining": this.retries,
			}
		);
		if (this.retries) {
			this.retries--;
			// retry
			this.requestOptions.timeout *= 3 + Math.random();
			this.request(this.requestOptions, this._requestCB.bind(this));
			return;
		} else {
			var dnee = new Error(this.reqType + ' failure for '
					+ JSON.stringify(this.queueKey.substr(0, 80)) + ': ' + error);
			this._handleBody(dnee, '{}');
		}
	} else if (response.statusCode === 200) {
		this.trace("Received HTTP 200, ", body.length, "bytes");
		this._handleBody(null, body);
	} else {
		this.trace("Received HTTP", response.statusCode, ": ", body);
		if (response.statusCode === 412) {
			this.env.log("info", "Cache MISS:", response.request.href);
		} else {
			this.env.log("warning", "non-200 response:", response.statusCode, body);
		}
		error = new Error(this.reqType + ' failure for '
					+ JSON.stringify(this.queueKey.substr(0, 80)) + ': ' + response.statusCode);
		this._handleBody(error, '{}');
	}

	// XXX: handle other status codes

	// Remove self from request queue
	delete this.env.requestQueue[this.queueKey];
};

/**
 * Default body handler: parse to JSON and call _handleJSON.
 *
 * @method
 * @private
 * @param {Error|null} error
 * @param {string} body The body of the response from the API
 */
ApiRequest.prototype._handleBody = function(error, body) {
	if (error) {
		this._handleJSON(error, {});
		return;
	}
	var data;
	try {
		// Strip the UTF8 BOM since it knowingly breaks parsing.
		if (body[0] === '\uFEFF') {
			this.env.log('warning', 'Stripping a UTF8 BOM. Your webserver is' +
				' likely broken.');
			body = body.slice(1);
		}
		data = JSON.parse(body);
	} catch (e) {
		if (!body) {
			// This is usually due to a fatal error on the PHP side, although
			// it would be nice (!) if PHP would return a non-200 error code
			// for this!
			error = new ParserError('Empty JSON response returned for ' +
				this.reqType);
		} else {
			error = new ParserError('Failed to parse the JSON response for ' +
				this.reqType);
		}
	}
	this._handleJSON(error, data);
};

ApiRequest.prototype.trace = function() {
	this.env.log.apply(null, ["trace/apirequest", "#" + this.serial].concat(Array.prototype.slice.call(arguments)));
};

/**
 * @class
 * @extends ApiRequest
 *
 * Template fetch request helper class
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} title The template (or really, page) we should fetch from the wiki
 * @param {string} oldid The revision ID you want to get, defaults to "latest revision"
 */
function TemplateRequest(env, title, oldid) {
	ApiRequest.call(this, env, title);
	// IMPORTANT: Set queueKey to the 'title'
	// since TemplateHandler uses it for recording listeners
	this.queueKey = title;
	this.reqType = "Template Fetch";

	var apiargs = {
		format: 'json',
		action: 'query',
		prop: 'info|revisions',
		rawcontinue: 1,
		rvprop: PARSOID_RVPROP,
	};

	if (oldid) {
		this.oldid = oldid;
		apiargs.revids = oldid;
	} else {
		apiargs.titles = title;
	}

	var uri = env.conf.wiki.apiURI;

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: uri,
		qs: apiargs,
		timeout: env.conf.parsoid.timeouts.mwApi.srcFetch,
	};

	// Start the request
	this.request(this.requestOptions, this._requestCB.bind(this));
}

// Inherit from ApiRequest
util.inherits(TemplateRequest, ApiRequest);

/**
 * @method _handleJSON
 * @template
 * @private
 * @param {Error} error
 * @param {Object} data The response from the server - parsed JSON object
 */
TemplateRequest.prototype._handleJSON = function(error, data) {
	var regex, title, location, iwstr, interwiki;
	var metadata = { title: this.title };

	logAPIWarnings(this, data);

	if (!error && !data.query) {
		error = this._errorObj(data, '', 'Missing data.query');
	}

	if (error) {
		this._processListeners(error, null);
		return;
	}

	if (data.query.normalized && data.query.normalized.length) {
		// update title (ie, "foo_Bar" -> "Foo Bar")
		metadata.title = data.query.normalized[0].to;
	}

	if (!data.query.pages) {
		if (data.query.interwiki) {
			// Essentially redirect, but don't actually redirect.
			interwiki = data.query.interwiki[0];
			title = interwiki.title;
			regex = new RegExp('^' + interwiki.iw + ':');
			title = title.replace(regex, '');
			iwstr = this.env.conf.wiki.interwikiMap.get(interwiki.iw).url ||
				this.env.conf.parsoid.mwApiMap.get(interwiki.iw).uri ||
				'/' + interwiki.iw + '/' + '$1';
			location = iwstr.replace('$1', title);
			error = new DoesNotExistError('The page at ' + this.title +
				' can be found at a different location: ' + location);
		} else {
			error = new DoesNotExistError(
				'No pages were returned from the API request for ' +
				this.title);
		}
	} else {
		// we've only requested one title (or oldid)
		// but we get a hash of pageids
		var self = this;
		if (!Object.keys(data.query.pages).some(function(pageid) {
			var page = data.query.pages[pageid];
			if (!page || !page.revisions || !page.revisions.length) {
				return false;
			}
			metadata.id = page.pageid;
			metadata.ns = page.ns;
			metadata.latest = page.lastrevid;
			metadata.revision = page.revisions[0];

			if (metadata.revision.texthidden || !metadata.revision.hasOwnProperty("*")) {
				error = new DoesNotExistError("Source is hidden for " + self.title);
			}
			return true;
		})) {
			error = new DoesNotExistError('Did not find page revisions for ' + this.title);
		}
	}

	if (error) {
		this._processListeners(error, null);
		return;
	}

	this.trace('Retrieved ' + this.title, metadata);

	// Add the source to the cache
	// (both original title as well as possible redirected title)
	this.env.pageCache[this.queueKey] = this.env.pageCache[this.title] = metadata.revision['*'];

	this._processListeners(null, metadata);
};

// Function which returns a promise for the result of a template request.
TemplateRequest.promise = promiseFor(TemplateRequest);

// Function which returns a promise to set page src info.
TemplateRequest.setPageSrcInfo = function(env, target, oldid) {
	return TemplateRequest.promise(env, target, oldid).then(function(src) {
		env.setPageSrcInfo(src);
	});
};

/**
 * @class
 * @extends ApiRequest
 *
 * Passes the source of a single preprocessor construct including its
 * parameters to action=expandtemplates
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} title The title of the page to use as the context
 * @param {string} text
 * @param {string} queueKey The queue key
 */
function PreprocessorRequest(env, title, text, queueKey) {
	ApiRequest.call(this, env, title);
	this.queueKey = queueKey;
	this.text = text;
	this.reqType = "Template Expansion";

	var apiargs = {
		format: 'json',
		action: 'expandtemplates',
		prop: 'wikitext|categories|properties|modules|jsconfigvars',
		text: text,
	};

	// the empty string is an invalid title
	// default value is: API
	if (title) {
		apiargs.title = title;
	}

	if (env.page.meta.revision.revid) {
		apiargs.revid = env.page.meta.revision.revid;
	}

	var uri = env.conf.wiki.apiURI;

	this.requestOptions = {
		// Use POST since we are passing a bit of source, and GET has a very
		// limited length. You'll be greeted by "HTTP Error 414 Request URI
		// too long" otherwise ;)
		method: 'POST',
		form: apiargs, // The API arguments
		followRedirect: true,
		uri: uri,
		timeout: env.conf.parsoid.timeouts.mwApi.preprocessor,
	};

	// Start the request
	this.request(this.requestOptions, this._requestCB.bind(this));
}


// Inherit from ApiRequest
util.inherits(PreprocessorRequest, ApiRequest);

PreprocessorRequest.prototype._handleJSON = function(error, data) {
	logAPIWarnings(this, data);

	if (!error && !(data && data.expandtemplates)) {
		error = this._errorObj(data, this.text, 'Missing data.expandtemplates.');
	}

	if (error) {
		this.env.log("error", error);
		this._processListeners(error, '');
	} else {
		this._processListeners(error,
			manglePreprocessorResponse(this.env, data.expandtemplates));
	}
};

/**
 * @class
 * @extends ApiRequest
 *
 * Gets the PHP parser to parse content for us.
 * Used for handling extension content right now.
 * And, probably magic words later on.
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} title The title of the page to use as context
 * @param {string} text
 * @param {boolean} [onlypst] Pass onlypst to PHP parser
 * @param {string} [queueKey] The queue key
 */
function PHPParseRequest(env, title, text, onlypst, queueKey) {
	ApiRequest.call(this, env, title);
	this.text = text;
	this.queueKey = queueKey || text;
	this.reqType = "Extension Parse";

	var apiargs = {
		format: 'json',
		action: 'parse',
		text: text,
		disablelimitreport: 'true',
		contentmodel: 'wikitext',
		prop: 'text|modules|jsconfigvars|categories',
	};
	if (onlypst) {
		apiargs.onlypst = 'true';
	}

	var uri = env.conf.wiki.apiURI;

	// Pass the page title to the API
	if (title) {
		apiargs.title = title;
	}

	this.requestOptions = {
		// Use POST since we are passing a bit of source, and GET has a very
		// limited length. You'll be greeted by "HTTP Error 414 Request URI
		// too long" otherwise ;)
		method: 'POST',
		form: apiargs, // The API arguments
		followRedirect: true,
		uri: uri,
		timeout: env.conf.parsoid.timeouts.mwApi.extParse,
	};

	// Start the request
	this.request(this.requestOptions, this._requestCB.bind(this));
}

// Inherit from ApiRequest
util.inherits(PHPParseRequest, ApiRequest);

// Function which returns a promise for the result of a parse request.
PHPParseRequest.promise = promiseFor(PHPParseRequest);

PHPParseRequest.prototype._handleJSON = function(error, data) {
	logAPIWarnings(this, data);

	if (!error && !(data && data.parse)) {
		error = this._errorObj(data, this.text, 'Missing data.parse.');
	}

	if (error) {
		this.env.log("error", error);
		this._processListeners(error, '');
	} else {
		this._processListeners(error, mangleParserResponse(this.env, data.parse));
	}
};

/**
 * @class
 * @extends ApiRequest
 *
 * Do a mixed-action batch request using the ParsoidBatchAPI extension.
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {Array} batchParams An array of objects
 * @param {string} key The queue key
 */
function BatchRequest(env, batchParams, key) {
	ApiRequest.call(this, env);
	this.queueKey = key;
	this.batchParams = batchParams;
	this.reqType = 'Batch request';

	this.batchText = JSON.stringify(batchParams);
	var apiargs = {
		format: 'json',
		formatversion: '2',
		action: 'parsoid-batch',
		batch: this.batchText,
	};

	this.requestOptions = {
		method: 'POST',
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		timeout: env.conf.parsoid.timeouts.mwApi.batch,
	};
	// Use multipart form encoding to get more efficient transfer if the gain
	// will be larger than the typical overhead.
	if (encodeURIComponent(apiargs.batch).length - apiargs.batch.length > 600) {
		this.requestOptions.formData = apiargs;
	} else {
		this.requestOptions.form = apiargs;
	}

	this.request(this.requestOptions, this._requestCB.bind(this));
}

util.inherits(BatchRequest, ApiRequest);

BatchRequest.prototype._handleJSON = function(error, data) {
	if (!error && !(data && data['parsoid-batch'] && Array.isArray(data['parsoid-batch']))) {
		error = this._errorObj(data, this.batchText, 'Missing/invalid data.parsoid-batch');
	}

	if (error) {
		this.env.log("error", error);
		this.emit('batch', error, null);
		return;
	}

	var batchResponse = data['parsoid-batch'];
	var callbackData = [];
	var index, itemParams, itemResponse, mangled;
	for (index = 0; index < batchResponse.length; index++) {
		itemParams = this.batchParams[index];
		itemResponse = batchResponse[index];
		switch (itemParams.action) {
			case 'parse':
				mangled = mangleParserResponse(this.env, itemResponse);
				break;
			case 'preprocess':
				mangled = manglePreprocessorResponse(this.env, itemResponse);
				break;
			case 'imageinfo':
				mangled = {batchResponse: itemResponse};
				break;
			default:
				error = new Error("BatchRequest._handleJSON: Invalid action");
				this.emit('batch', error, null);
				return;
		}
		callbackData.push(mangled);

	}
	this.emit('batch', error, callbackData);
};

/**
 * @class
 * @extends ApiRequest
 *
 * A request for the wiki's configuration variables.
 *
 * @constructor
 * @param {string} uri The API URI to use for fetching
 * @param {MWParserEnvironment} env
 * @param {string} proxy (optional) The proxy to use for the ConfigRequest.
 */
var ConfigRequest = function(uri, env, proxy) {
	ApiRequest.call(this, env, null);
	this.queueKey = uri;
	this.reqType = "Config Request";

	// Use the passed in proxy to the mw api. The default proxy set in
	// the ApiRequest constructor might not be the right one.
	this.proxy = proxy;

	if (!uri) {
		this.retries = env.conf.parsoid.retries.mwApi.configInfo;
		this._requestCB(new Error('There was no base URI for the API we tried to use.'));
		return;
	}

	var metas = [ 'siteinfo' ];
	var siprops = [
		'namespaces',
		'namespacealiases',
		'magicwords',
		'functionhooks',
		'extensiontags',
		'general',
		'interwikimap',
		'languages',
		'protocols',
		'specialpagealiases',
	];
	var apiargs = {
		format: 'json',
		action: 'query',
		meta: metas.join('|'),
		siprop: siprops.join('|'),
		rawcontinue: 1,
	};

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: uri,
		qs: apiargs,
		timeout: env.conf.parsoid.timeouts.mwApi.configInfo,
	};

	this.request(this.requestOptions, this._requestCB.bind(this));
};

util.inherits(ConfigRequest, ApiRequest);

ConfigRequest.prototype._handleJSON = function(error, data) {
	var resultConf = null;

	logAPIWarnings(this, data);

	if (!error) {
		if (data && data.query) {
			error = null;
			resultConf = data.query;
		} else if (data && data.error) {
			if (data.error.code === 'readapidenied') {
				error = new AccessDeniedError();
			} else {
				error = this._errorObj(data);
			}
		} else {
			error = this._errorObj(data, '',
				'No result.\n' + JSON.stringify(data, '\t', 2));
			error.suppressLoggingStack = true;
		}
	}

	this._processListeners(error, resultConf);
};

// Function which returns a promise for the result of a config request.
ConfigRequest.promise = promiseFor(ConfigRequest);

/**
 * @class
 * @extends ApiRequest
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} filename
 * @param {Object} [dims]
 * @param {number} [dims.width]
 * @param {number} [dims.height]
 */
function ImageInfoRequest(env, filename, dims, key) {
	ApiRequest.call(this, env, null);
	this.env = env;
	this.queueKey = key;
	this.reqType = "Image Info Request";

	var conf = env.conf.wiki;
	var uri = conf.apiURI;
	var filenames = [ filename ];
	var imgnsid = conf.canonicalNamespaces.image;
	var imgns = conf.namespaceNames[imgnsid];
	var props = [
		'mediatype',
		'size',
		'url',
	];

	this.ns = imgns;

	for (var ix = 0; ix < filenames.length; ix++) {
		filenames[ix] = imgns + ':' + filenames[ix];
	}

	var apiArgs = {
		action: 'query',
		format: 'json',
		prop: 'imageinfo',
		titles: filenames.join('|'),
		iiprop: props.join('|'),
		rawcontinue: 1,
	};

	if (dims) {
		if (dims.width) {
			apiArgs.iiurlwidth = dims.width;
		}
		if (dims.height) {
			apiArgs.iiurlheight = dims.height;
		}
	}

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: uri,
		qs: apiArgs,
		timeout: env.conf.parsoid.timeouts.mwApi.imgInfo,
	};

	this.request(this.requestOptions, this._requestCB.bind(this));
}

util.inherits(ImageInfoRequest, ApiRequest);

ImageInfoRequest.prototype._handleJSON = function(error, data) {
	var pagenames, names, newpages, pages, pagelist, ix;

	logAPIWarnings(this, data);

	if (error) {
		this._processListeners(error, { imgns: this.ns });
		return;
	}

	if (data && data.query) {
		// The API indexes its response by page ID. That's inconvenient.
		newpages = {};
		pagenames = {};
		pages = data.query.pages;
		names = data.query.normalized;
		pagelist = Object.keys(pages);

		if (names) {
			for (ix = 0; ix < names.length; ix++) {
				pagenames[names[ix].to] = names[ix].from;
			}
		}

		for (ix = 0; ix < pagelist.length; ix++) {
			if (pagenames[pages[pagelist[ix]].title]) {
				newpages[pagenames[pages[pagelist[ix]].title]] = pages[pagelist[ix]];
			}
			newpages[pages[pagelist[ix]].title] = pages[pagelist[ix]];
		}

		data.query.pages = newpages;
		data.query.imgns = this.ns;
		this._processListeners(null, data.query);
	} else if (data && data.error) {
		if (data.error.code === 'readapidenied') {
			error = new AccessDeniedError();
		} else {
			error = this._errorObj(data);
		}
		this._processListeners(error, {});
	} else {
		this._processListeners(null, {});
	}
};

/**
 * Fetch TemplateData info for a template.
 * This is used by the html -> wt serialization path.
 *
 * @param {MWParserEnvironment} env
 * @param {string} template
 * @param {string} [queueKey] The queue key
 */
function TemplateDataRequest(env, template, queueKey) {
	ApiRequest.call(this, env, null);
	this.env = env;
	this.text = template;
	this.queueKey = queueKey;
	this.reqType = "TemplateData Request";

	var apiargs = {
		format: 'json',
		action: 'templatedata',
		titles: template,
	};

	this.requestOptions = {
		// Use GET so this request can be cached in Varnish
		method: 'GET',
		qs: apiargs,
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		timeout: env.conf.parsoid.timeouts.mwApi.templateData,
	};

	this.request(this.requestOptions, this._requestCB.bind(this));
}

// Inherit from ApiRequest
util.inherits(TemplateDataRequest, ApiRequest);

// Function which returns a promise for the result of a templatedata request.
TemplateDataRequest.promise = promiseFor(TemplateDataRequest);

TemplateDataRequest.prototype._handleJSON = function(error, data) {
	logAPIWarnings(this, data);

	if (!error && !(data && data.pages)) {
		error = this._errorObj(data, this.text, 'Missing data.pages.');
	}

	if (error) {
		this.env.log("error", error);
		this._processListeners(error, '');
	} else {
		this._processListeners(error, data.pages);
	}
};

if (typeof module === "object") {
	module.exports.ConfigRequest = ConfigRequest;
	module.exports.TemplateRequest = TemplateRequest;
	module.exports.PreprocessorRequest = PreprocessorRequest;
	module.exports.PHPParseRequest = PHPParseRequest;
	module.exports.BatchRequest = BatchRequest;
	module.exports.ImageInfoRequest = ImageInfoRequest;
	module.exports.TemplateDataRequest = TemplateDataRequest;
	module.exports.DoesNotExistError = DoesNotExistError;
	module.exports.ParserError = ParserError;
}
