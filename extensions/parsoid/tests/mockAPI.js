// This file is used to run a stub API that mimics the MediaWiki interface
// for the purposes of testing extension expansion.

'use strict';
require('../core-upgrade.js');

var express = require('express');
var bodyParser = require('body-parser');
var crypto = require('crypto');

var Promise = require('../lib/utils/promise.js');

// Get Parsoid limits.
var fakeConfig = {
	setMwApi: function() {},
	limits: { wt2html: {}, html2wt: {} },
	timeouts: { mwApi: {} },
};
require('./mocha/apitest.localsettings.js').setup(fakeConfig);

// configuration to match PHP parserTests
var IMAGE_BASE_URL = 'http://example.com/images';
var IMAGE_DESC_URL = IMAGE_BASE_URL;
// IMAGE_BASE_URL='http://upload.wikimedia.org/wikipedia/commons';
// IMAGE_DESC_URL='http://commons.wikimedia.org/wiki';
var FILE_PROPS = {
	'Foobar.jpg': {
		size: 7881,
		width: 1941,
		height: 220,
		bits: 8,
		mime: 'image/jpeg',
	},
	'Thumb.png': {
		size: 22589,
		width: 135,
		height: 135,
		bits: 8,
		mime: 'image/png',
	},
	'Foobar.svg': {
		size: 12345,
		width: 240,
		height: 180,
		bits: 24,
		mime: 'image/svg+xml',
	},
	'LoremIpsum.djvu': {
		size: 3249,
		width: 2480,
		height: 3508,
		bits: 8,
		mime: 'image/vnd.djvu',
	},
};

/* -------------------- web app access points below --------------------- */

var app = express();
app.use(bodyParser.urlencoded({ extended: false }));

function sanitizeHTMLAttribute(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

var mainPage = {
	query: {
		pages: {
			'1': {
				pageid: 1,
				ns: 0,
				title: 'Main Page',
				revisions: [
					{
						revid: 1,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': '<strong>MediaWiki has been successfully installed.</strong>\n\nConsult the [//meta.wikimedia.org/wiki/Help:Contents User\'s Guide] for information on using the wiki software.\n\n== Getting started ==\n* [//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings Configuration settings list]\n* [//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ MediaWiki FAQ]\n* [https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce MediaWiki release mailing list]\n* [//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources Localise MediaWiki for your language]',
					},
				],
			},
		},
	},
};

var junkPage = {
	query: {
		pages: {
			'2': {
				pageid: 2,
				ns: 0,
				title: "Junk Page",
				revisions: [
					{
						revid: 2,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': '2. This is just some junk. See the comment above.',
					},
				],
			},
		},
	},
};

var largePage = {
	query: {
		pages: {
			'3': {
				pageid: 3,
				ns: 0,
				title: 'Large_Page',
				revisions: [
					{
						revid: 3,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': 'a'.repeat(fakeConfig.limits.wt2html.maxWikitextSize + 1),
					},
				],
			},
		},
	},
};

var reusePage = {
	query: {
		pages: {
			'100': {
				pageid: 100,
				ns: 0,
				title: 'Reuse_Page',
				revisions: [
					{
						revid: 100,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': '{{colours of the rainbow}}',
					},
				],
			},
		},
	},
};

var jsonPage = {
	query: {
		pages: {
			'101': {
				pageid: 101,
				ns: 0,
				title: 'JSON_Page',
				revisions: [
					{
						revid: 101,
						parentid: 0,
						contentmodel: 'json',
						contentformat: 'text/json',
						'*': '[1]',
					},
				],
			},
		},
	},
};

var fnames = {
	'Image:Foobar.jpg': 'Foobar.jpg',
	'File:Foobar.jpg': 'Foobar.jpg',
	'Image:Foobar.svg': 'Foobar.svg',
	'File:Foobar.svg': 'Foobar.svg',
	'Image:Thumb.png': 'Thumb.png',
	'File:Thumb.png': 'Thumb.png',
	'File:LoremIpsum.djvu': 'LoremIpsum.djvu',
};

var pnames = {
	'Image:Foobar.jpg': 'File:Foobar.jpg',
	'Image:Foobar.svg': 'File:Foobar.svg',
	'Image:Thumb.png': 'File:Thumb.png',
};

// This templatedata description only provides a subset of fields
// that mediawiki API returns. Parsoid only uses the format and
// paramOrder fields at this point, so keeping these lean.
var templateData = {
	'Template:NoFormatWithParamOrder': {
		'paramOrder': ['unused1', 'f1', 'unused2', 'f2', 'unused3'],
	},
	'Template:InlineTplNoParamOrder': {
		'format': 'inline',
	},
	'Template:BlockTplNoParamOrder': {
		'format': 'block',
	},
	'Template:InlineTplWithParamOrder': {
		'format': 'inline',
		'paramOrder': ['f1','f2'],
	},
	'Template:BlockTplWithParamOrder': {
		'format': 'block',
		'paramOrder': ['f1','f2'],
	},
};

var formatters = {
	json: function(data) {
		return JSON.stringify(data);
	},
	jsonfm: function(data) {
		return JSON.stringify(data, null, 2);
	},
};

var availableActions = {
	parse: function(body, cb) {
		var resultText;
		var text = body.text;
		var onlypst = body.onlypst;
		var re = /<testextension(?: ([^>]*))?>((?:[^<]|<(?!\/testextension>))*)<\/testextension>/;
		var replaceString = '<p data-options="$1">$2</p>';
		var result = text.match(re);

		// I guess this doesn't need to be a function anymore, but still.
		function handleTestExtension(opts, content) {
			var optHash = {};
			opts = opts.split(/ +/);
			for (var i = 0; i < opts.length; i++) {
				var opt = opts[i].split('=');
				optHash[opt[0]] = opt[1].trim().replace(/(^"|"*$)/g, '');
			}
			return replaceString
				.replace('$1', sanitizeHTMLAttribute(JSON.stringify(optHash)))
				.replace('$2', sanitizeHTMLAttribute(content));
		}

		if (result) {
			resultText = handleTestExtension(result[1], result[2]);
		} else if (onlypst) {
			resultText = body.text.replace(/\{\{subst:echo\|([^}]+)\}\}/, "$1");
		} else {
			resultText = body.text;
		}

		cb(null, { parse: { text: { '*': resultText } } });
	},

	querySiteinfo: function(body, cb) {
		// TODO: Read which language should we use from somewhere.
		cb(null, require('../lib/config/baseconfig/enwiki.json'));
	},

	query: function(body, cb) {
		if (body.meta === 'siteinfo') {
			return this.querySiteinfo(body, cb);
		}

		if (body.prop === "info|revisions") {
			if (body.revids === "1" || body.titles === "Main_Page") {
				return cb(null , mainPage);
			} else if (body.revids === "2" || body.titles === "Junk_Page") {
				return cb(null , junkPage);
			} else if (body.revids === '3' || body.titles === 'Large_Page') {
				return cb(null , largePage);
			} else if (body.revids === '100' || body.titles === 'Reuse_Page') {
				return cb(null , reusePage);
			} else if (body.revids === '101' || body.titles === 'JSON_Page') {
				return cb(null , jsonPage);
			}
		}

		var filename = body.titles;
		var normPagename = pnames[filename] || filename;
		var normFilename = fnames[filename] || filename;
		if (!(normFilename in FILE_PROPS)) {
			cb(null, {
				'query': {
					'pages': {
						'-1': {
							'ns': 6,
							'title': filename,
							'missing': '',
							'imagerepository': '',
						},
					},
				},
			});
			return;
		}
		var props = FILE_PROPS[normFilename] || Object.create(null);
		var md5 = crypto.createHash('md5').update(normFilename).digest('hex');
		var md5prefix = md5[0] + '/' + md5[0] + md5[1] + '/';
		var baseurl = IMAGE_BASE_URL + '/' + md5prefix + normFilename;
		var height = props.height || 220;
		var width = props.width || 1941;
		var twidth = body.iiurlwidth;
		var theight = body.iiurlheight;
		var turl = IMAGE_BASE_URL + '/thumb/' + md5prefix + normFilename;
		var durl = IMAGE_DESC_URL + '/' + normFilename;
		var mediatype = (props.mime === 'image/svg+xml') ? 'DRAWING' : 'BITMAP';
		var imageinfo = {
			pageid: 1,
			ns: 6,
			title: normPagename,
			imageinfo: [
				{
					size: props.size || 12345,
					height: height,
					width: width,
					url: baseurl,
					descriptionurl: durl,
					mediatype: mediatype,
				},
			],
		};
		var response = {
			query: {
				normalized: [{ from: filename, to: normPagename }],
				pages: {},
			},
		};

		if (twidth || theight) {
			if (twidth && (theight === undefined || theight === null)) {
				// File::scaleHeight in PHP
				theight = Math.round(height * twidth / width);
			} else if (theight && (twidth === undefined || twidth === null)) {
				// MediaHandler::fitBoxWidth in PHP
				// This is crazy!
				var idealWidth = width * theight / height;
				var roundedUp = Math.ceil(idealWidth);
				if (Math.round(roundedUp * height / width) > theight) {
					twidth = Math.floor(idealWidth);
				} else {
					twidth = roundedUp;
				}
			} else {
				if (Math.round(height * twidth / width) > theight) {
					twidth = Math.ceil(width * theight / height);
				} else {
					theight = Math.round(height * twidth / width);
				}
			}
			if (twidth >= width || theight >= height) {
				// the PHP api won't enlarge an image
				twidth = width;
				theight = height;
			}

			turl += '/' + twidth + 'px-' + normFilename;
			imageinfo.imageinfo[0].thumbwidth = twidth;
			imageinfo.imageinfo[0].thumbheight = theight;
			imageinfo.imageinfo[0].thumburl = turl;
		}

		response.query.pages['1'] = imageinfo;
		cb(null, response);
	},

	expandtemplates: function(body, cb) {
		var match = body.text.match(/{{echo\|(.*?)}}/);
		if (match) {
			cb(null, { expandtemplates: { wikitext: match[1] } });
		} else if (body.text === '{{colours of the rainbow}}') {
			cb(null, { expandtemplates: { wikitext: 'purple' } });
		} else {
			cb(new Error('Sorry!'));
		}
	},

	// Return a dummy response
	templatedata: function(body, cb) {
		cb(null, {
			// FIXME: Assumes that body.titles is a single title
			// (which is how Parsoid uses this endpoint right now).
			'pages': {
				'1': templateData[body.titles] || {},
			},
		});
	},
};

var actionDefinitions = {
	parse: {
		parameters: {
			text: 'text',
			title: 'text',
			onlypst: 'boolean',
		},
	},
	query: {
		parameters: {
			titles: 'text',
			prop: 'text',
			iiprop: 'text',
			iiurlwidth: 'text',
			iiurlheight: 'text',
		},
	},
};

var actionRegex = Object.keys(availableActions).join('|');

function buildOptions(options) {
	var optStr = '';
	for (var i = 0; i < options.length; i++) {
		optStr += '<option value="' + options[i] + '">' + options[i] + '</option>';
	}
	return optStr;
}

function buildActionList() {
	var actions = Object.keys(availableActions);
	var setStr = '';
	for (var i = 0; i < actions.length; i++) {
		var action = actions[i];
		var title = 'action=' + action;
		setStr += '<li id="' + title + '">';
		setStr += '<a href="/' + action + '">' + title + '</a></li>';
	}
	return setStr;
}

function buildForm(action) {
	var formStr = '';
	var actionDef = actionDefinitions[action];
	var params = actionDef.parameters;
	var paramList = Object.keys(params);

	for (var i = 0; i < paramList.length; i++) {
		var param = paramList[i];
		if (typeof params[param] === 'string') {
			formStr += '<input type="' + params[param] + '" name="' + param + '" />';
		} else if (params[param].length) {
			formStr += '<select name="' + param + '">';
			formStr += buildOptions(params[param]);
			formStr += '</select>';
		}
	}
	return formStr;
}

// GET request to root....should probably just tell the client how to use the service
app.get('/', function(req, res) {
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	res.write(
		'<html><body>' +
			'<ul id="list-of-actions">' +
				buildActionList() +
			'</ul>' +
		'</body></html>');
	res.end();
});

// GET requests for any possible actions....tell the client how to use the action
app.get(new RegExp('^/(' + actionRegex + ')'), function(req, res) {
	var formats = buildOptions(Object.keys(formatters));
	var action = req.params[0];
	var returnHtml =
			'<form id="service-form" method="GET" action="api.php">' +
				'<h2>GET form</h2>' +
				'<input name="action" type="hidden" value="' + action + '" />' +
				'<select name="format">' +
					formats +
				'</select>' +
				buildForm(action) +
				'<input type="submit" />' +
			'</form>' +
			'<form id="service-form" method="POST" action="api.php">' +
				'<h2>POST form</h2>' +
				'<input name="action" type="hidden" value="' + action + '" />' +
				'<select name="format">' +
					formats +
				'</select>' +
				buildForm(action) +
				'<input type="submit" />' +
			'</form>';

	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	res.write(returnHtml);
	res.end();
});

function handleApiRequest(body, res) {
	var format = body.format;
	var action = body.action;
	var formatter = formatters[format || "json"];

	if (!availableActions.hasOwnProperty(action)) {
		return res.status(400).end("Unknown action.");
	}

	availableActions[action](body, function(err, data) {
		if (err === null) {
			res.setHeader('Content-Type', 'application/json');
			res.write(formatter(data));
			res.end();
		} else {
			res.setHeader('Content-Type', 'text/plain');
			res.status(err.httpStatus || 500);
			res.write(err.stack || err.toString());
			res.end();
		}
	});
}

// GET request to api.php....actually perform an API request
app.get('/api.php', function(req, res) {
	handleApiRequest(req.query, res);
});

// POST request to api.php....actually perform an API request
app.post('/api.php', function(req, res) {
	handleApiRequest(req.body, res);
});

module.exports = function(options) {
	var logger = options.logger;
	var server;
	return new Promise(function(resolve, reject) {
		app.on('error', function(err) {
			logger.log('error', err);
			reject(err);
		});
		server = app.listen(options.config.port, options.config.iface, resolve);
	}).then(function() {
		var port = server.address().port;
		logger.log('info', 'Mock MediaWiki API: Started on ' + port);
		return {
			close: function() {
				return Promise.promisify(server.close, false, server)();
			},
			port: port,
		};
	});
};
