'use strict';
require('../core-upgrade.js');

/**
 * Manages different services for testing.
 */

var net = require('net');
var path = require('path');

var Promise = require('../lib/utils/promise.js');
var ServiceRunner = require('service-runner');

// Select a free port at random.
var choosePort = function() {
	return new Promise(function(resolve, reject) {
		var server = net.createServer();
		var port = 0;
		server.on('listening', function() {
			port = server.address().port;
			server.close();
		});
		server.on('close', function() {
			resolve(port);
		});
		server.on('error', function(err) {
			reject(err);
		});
		server.listen(port, 'localhost');
	});
};

var runServices = function(options) {
	var services = [];
	var ret = {};
	var p = Promise.resolve();

	if (!options.skipMock) {
		if (options.mockURL) {
			p = Promise.resolve(options.mockURL);
		} else {
			p = choosePort().then(function(mockPort) {
				services.push({
					module: path.resolve(__dirname, './mockAPI.js'),
					conf: {
						port: mockPort,
						iface: 'localhost',
					},
				});
				return 'http://localhost:' + mockPort + '/api.php';
			});
		}
		p = p.then(function(mockURL) {
			process.env.PARSOID_MOCKAPI_URL = mockURL;
			ret.mockURL = mockURL;
		});
	}

	if (!options.skipParsoid) {
		p = p.then(choosePort).then(function(parsoidPort) {
			services.push({
				module: path.resolve(__dirname, '../lib/index.js'),
				entrypoint: 'apiServiceWorker',
				conf: {
					serverPort: parsoidPort,
					serverInterface: 'localhost',
					localsettings: options.localsettings ||
						path.resolve(__dirname, './rttest.localsettings.js'),
				},
			});
			ret.parsoidURL = 'http://localhost:' + parsoidPort + '/';
		});
	}

	return p.then(function() {
		var runner = new ServiceRunner({
			// We need to pass in options object here, otherwise service-runner
			// gets the defaults from yargs, which isn't the right thing to do
			// in this case.  This property is expected to be a number though.
			num_workers: -1,
		});
		ret.runner = runner;
		return runner.start({
			num_workers: 1,
			worker_heartbeat_timeout: 2 * 60 * 1000,
			logging: {
				level: 'info',  // Default is 'warn'
			},
			services: services,
		})
		.then(function() {
			return ret;
		});
	});
};

module.exports = { runServices: runServices };
