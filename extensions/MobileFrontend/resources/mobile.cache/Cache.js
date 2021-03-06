( function ( M ) {

	/* This module defines several types of cache classes to use in other
	 * modules.
	 * The interface, that all types use, is kept synchronous driven by current
	 * usage patterns, but will need to be revisited in case usage patterns
	 * suggest we need asynchronous caches.
	 */

	/**
	 * In memory cache implementation
	 *
	 * @class MemoryCache
	 */
	function MemoryCache() {
		this._cache = {};
	}

	/**
	 * Retrieve a cached value from a key
	 * @method get
	 * @param {String} key
	 * @returns {*}
	 */
	MemoryCache.prototype.get = function ( key ) {
		return this._cache[ key ];
	};

	/**
	 * Cache a value by key
	 * @method set
	 * @param {String} key
	 * @param {*} value
	 */
	MemoryCache.prototype.set = function ( key, value ) {
		this._cache[ key ] = value;
	};

	/**
	 * Null object cache implementation
	 *
	 * @class NoCache
	 */
	function NoCache() { }

	/**
	 * NoOp
	 * @method get
	 */
	NoCache.prototype.get = function () { };

	/**
	 * NoOp
	 * @method set
	 */
	NoCache.prototype.set = function () { };

	M.define( 'mobile.cache', {
		MemoryCache: MemoryCache,
		NoCache: NoCache
	} );
} )( mw.mobileFrontend );
