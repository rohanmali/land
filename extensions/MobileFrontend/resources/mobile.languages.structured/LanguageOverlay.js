( function ( M, $ ) {

	var Overlay = M.require( 'mobile.overlays/Overlay' ),
		util = M.require( 'mobile.languages.structured/util' );

	/**
	 * Overlay displaying a structured list of languages for a page
	 *
	 * @class LanguageOverlay
	 * @extends Overlay
	 */
	function LanguageOverlay( options ) {
		var languages;

		languages = util.getStructuredLanguages(
			options.languages,
			options.variants,
			util.getFrequentlyUsedLanguages(),
			options.deviceLanguage
		);
		options.allLanguages = languages.all;
		options.allLanguagesCount = languages.all.length;
		options.suggestedLanguages = languages.suggested;
		options.suggestedLanguagesCount = languages.suggested.length;

		Overlay.call( this, options );
	}

	OO.mfExtend( LanguageOverlay, Overlay, {
		/** @inheritdoc */
		className: Overlay.prototype.className + ' language-overlay',
		/**
		 * @inheritdoc
		 * @cfg {Object} defaults
		 * @cfg {Object[]} defaults.languages each object has keys as
		 *  returned by the langlink API https://www.mediawiki.org/wiki/API:Langlinks
		 */
		defaults: $.extend( {}, Overlay.prototype.defaults, {
			heading: mw.msg( 'mobile-frontend-language-heading' ),
			inputPlaceholder: mw.msg( 'mobile-frontend-languages-structured-overlay-search-input-placeholder' ),
			// we can't rely on CSS only to uppercase the headings. See https://stackoverflow.com/questions/3777443/css-text-transform-not-working-properly-for-turkish-characters
			allLanguagesHeader: mw.msg( 'mobile-frontend-languages-structured-overlay-all-languages-header' ).toLocaleUpperCase(),
			suggestedLanguagesHeader: mw.msg( 'mobile-frontend-languages-structured-overlay-suggested-languages-header' ).toLocaleUpperCase(),
			headerChrome: false
		} ),
		/** @inheritdoc */
		templatePartials: $.extend( {}, Overlay.prototype.templatePartials, {
			content: mw.template.get( 'mobile.languages.structured', 'LanguageOverlay.hogan' )
		} ),
		/** @inheritdoc */
		events: $.extend( {}, Overlay.prototype.events, {
			'click a': 'onLinkClick',
			'input .search': 'onSearchInput'
		} ),
		/** @inheritdoc */
		postRender: function () {
			Overlay.prototype.postRender.apply( this );

			// cache
			this.$siteLinksList = this.$( '.site-link-list' );
			this.$languageItems = this.$siteLinksList.find( 'a' );
			this.$subheaders = this.$( 'h3' );
		},
		/**
		 * Article link click event handler
		 * @param {jQuery.Event} ev
		 */
		onLinkClick: function ( ev ) {
			var $link = this.$( ev.currentTarget ),
				lang = $link.attr( 'lang' ),
				$visibleLanguageLinks = this.$languageItems.filter( ':visible' ),
				index;

			util.saveLanguageUsageCount( lang, util.getFrequentlyUsedLanguages() );

			// find the index of the clicked language in the list of visible results
			$.each( $visibleLanguageLinks, function ( i, link ) {
				index = i + 1;
				if ( $( link ).hasClass( lang ) ) {
					return false;
				}
			} );
		},

		/**
		 * Search input handler
		 * @param {jQuery.Event} ev Event object.
		 */
		onSearchInput: function ( ev ) {
			this.filterLanguages( $( ev.target ).val().toLowerCase() );
		},

		/**
		 * Filter the language list to only show languages that match the current search term.
		 *
		 * @param {String} val of search term (lowercase).
		 */
		filterLanguages: function ( val ) {
			var filteredList = [];

			if ( val ) {
				$.each( this.options.languages, function ( i, language ) {
					var langname = language.langname;
					// search by language code or language name
					if ( language.autonym.toLowerCase().indexOf( val ) > -1 ||
							( langname && langname.toLowerCase().indexOf( val ) > -1 ) ||
							language.lang.toLowerCase().indexOf( val ) > -1
					) {
						filteredList.push( language.lang );
					}
				} );

				if ( this.options.variants ) {
					$.each( this.options.variants, function ( i, variant ) {
						// search by variant code or variant name
						if ( variant.autonym.toLowerCase().indexOf( val ) > -1 ||
							variant.lang.toLowerCase().indexOf( val ) > -1
						) {
							filteredList.push( variant.lang );
						}
					} );
				}

				this.$languageItems.addClass( 'hidden' );
				if ( filteredList.length ) {
					this.$siteLinksList.find( '.' + filteredList.join( ',.' ) ).removeClass( 'hidden' );
				}
				this.$siteLinksList.addClass( 'filtered' );
				this.$subheaders.addClass( 'hidden' );
			} else {
				this.$languageItems.removeClass( 'hidden' );
				this.$siteLinksList.removeClass( 'filtered' );
				this.$subheaders.removeClass( 'hidden' );
			}
		}
	} );

	M.define( 'mobile.languages.structured/LanguageOverlay', LanguageOverlay );

}( mw.mobileFrontend, jQuery ) );
