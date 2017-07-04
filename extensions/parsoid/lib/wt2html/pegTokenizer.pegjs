/**
 * Combined Wiki (MediaWiki) and HTML tokenizer based on pegjs. Emits several
 * chunks of tokens (one chunk per top-level block matched) and eventually an
 * end event. Tokens map to HTML tags as far as possible, with custom tokens
 * used where further processing on the token stream is needed.
 */
{

    var pegIncludes = options.pegIncludes;
    var DU = pegIncludes.DOMUtils;
    var Util = pegIncludes.Util;
    var JSUtils = pegIncludes.JSUtils;
    var PegTokenizer = pegIncludes.PegTokenizer;
    var defines = pegIncludes.defines;
    var constants = pegIncludes.constants;
    var tu = pegIncludes.tu;

    // define some constructor shortcuts
    var KV = defines.KV;
    var TagTk = defines.TagTk;
    var SelfclosingTagTk = defines.SelfclosingTagTk;
    var EndTagTk = defines.EndTagTk;
    var NlTk = defines.NlTk;
    var CommentTk = defines.CommentTk;
    var EOFTk = defines.EOFTk;
    var lastItem = JSUtils.lastItem;
    var env = options.env;

    var inlineBreaks = tu.inlineBreaks;
    var stops = new tu.SyntaxStops();

    var prevOffset = 0;

    // Some shorthands for legibility
    var startOffset = function() {
      return location().start.offset;
    };
    var endOffset = function() {
      return location().end.offset;
    };
    var tsrOffsets = function(flag) {
      return tu.tsrOffsets(location(), flag);
    };

    /*
     * Emit a chunk of tokens to our consumers.  Once this has been done, the
     * current expression can return an empty list (true).
     */
    var emitChunk = function(tokens) {
        // Shift tsr of all tokens by the pipeline offset
        Util.shiftTokenTSR(tokens, options.pipelineOffset);
        env.log("trace/peg", options.pegTokenizer.pipelineId, "---->  ", tokens);

        var i;
        var n = tokens.length;

        // Enforce parsing resource limits
        for (i = 0; i < n; i++) {
            tu.enforceParserResourceLimits(env, tokens[i]);
        }

        // limit the size of individual chunks
        var chunkLimit = 100000;
        if (n > chunkLimit) {
            i = 0;
            while (i < n) {
                options.cb(tokens.slice(i, i + chunkLimit));
                i += chunkLimit;
            }
        } else {
            options.cb(tokens);
        }
    };

}

/*********************************************************
 * The top-level rule
 *********************************************************/

start "start"
  = tlb* newline* {
      // end is passed inline as a token, as well as a separate event for now.
      emitChunk([ new EOFTk() ]);
      return true;
  }

/*
 * Redirects can only occur as the first thing in a document.  See
 * WikitextContent::getRedirectTarget()
 */
redirect
  = rw:redirect_word
    sp:$space_or_newline*
    c:$(":" space_or_newline*)?
    wl:wikilink & {
      return wl.length === 1 && wl[0] && wl[0].constructor !== String;
  } {
    var link = wl[0];
    if (sp) { rw += sp; }
    if (c) { rw += c; }
    // Build a redirect token
    var redirect = new SelfclosingTagTk('mw:redirect',
            // Put 'href' into attributes so it gets template-expanded
            [Util.lookupKV(link.attribs, 'href')],
            {
                src: rw,
                tsr: tsrOffsets(),
                linkTk: link,
            });
    return redirect;
}

// These rules are exposed as start rules.
generic_newline_attributes "generic_newline_attributes" = generic_newline_attribute*
table_attributes "table_attributes"
  = (table_attribute / optionalSpaceToken b:broken_table_attribute_name_char { return b; })*

/* The 'redirect' magic word.
 * The leading whitespace allowed is due to the PHP trim() function.
 */
redirect_word
  = $([ \t\n\r\0\x0b]*
    rw:$(!space_or_newline ![:\[] .)+
    & { return env.conf.wiki.getMagicWordMatcher('redirect').test(rw); })

/*
 * This rule exists to support tokenizing the document in chunks.
 * The parser's streaming interface will stop tokenization after each iteration
 * of the starred subexpression, and yield to the node.js event-loop to
 * schedule other pending event handlers.
 */
start_async
  = (tlb
    / newline* &{
      if (endOffset() === input.length) {
          emitChunk([ new EOFTk() ]);
      }
      // terminate the loop
      return false;
    }
    )*

/*
 * A document (start rule) is a sequence of toplevelblocks. Tokens are
 * emitted in chunks per toplevelblock to avoid buffering the full document.
 */
tlb "tlb"
  = !eof b:block {
    // Clear the tokenizer's backtracking cache after matching each
    // toplevelblock. There won't be any backtracking as a document is just a
    // sequence of toplevelblocks, so the cache for previous toplevelblocks
    // will never be needed.
    var end = startOffset();
    for (; prevOffset < end; prevOffset++) {
        peg$cache[prevOffset] = undefined;
    }

    var tokens;
    if (Array.isArray(b) && b.length) {
        tokens = tu.flattenIfArray(b);
    } else if (b && b.constructor === String) {
        tokens = [b];
    }

    // Emit tokens for this toplevelblock. This feeds a chunk to the parser pipeline.
    if (tokens) {
        emitChunk(tokens);
    }

    // We don't return any tokens to the start rule to save memory. We
    // just emitted them already to our consumers.
    return true;
  }

/*
 * The actual contents of each block.
 */
block
  = &sof r:redirect {return [r];} // has to be first alternative; otherwise gets parsed as a <ol>
    / block_lines
    / & '<' rs:( pre // tag variant can start anywhere
            / c:comment &eolf { return c; }
            / nowiki
            // avoid a paragraph if we know that the line starts with a block tag
            / bt:block_tag
            ) { return rs; }
    / paragraph
    // Inlineline includes generic tags; wrapped into paragraphs in token
    // transform and DOM postprocessor
    / inlineline
    / s:sol !inline_breaks { return s; }

/*
 * A block nested in other constructs. Avoid eating end delimiters for other
 * constructs by checking against inline_breaks first.
 */
nested_block = !inline_breaks b:block { return b; }

nested_block_line = bs:(!sol !inline_breaks b:block { return b; })* {
    return tu.flattenIfArray(bs);
}

/*
 * The same, but suitable for use inside a table construct.
 * Doesn't match table_heading_tag, table_row_tag, table_data_tag,
 * table_caption tag, or table_end_tag, although it does allow
 * table_start_tag (for nested tables).
 */
nested_block_in_table
  =
    // avoid recursion via nested_block_in_table, as that can lead to stack
    // overflow in large tables
    // See https://phabricator.wikimedia.org/T59670
    & { return stops.push('tableDataBlock', true); }
    // XXX: don't rely on a lame look-ahead like this; use syntax stops
    // instead, so that multi-line th content followed by a line prefixed with
    // a comment is also handled. Alternatively, implement a sol look-behind
    // assertion accepting spaces and comments.
    !(sol (space* sol)? space* (pipe / "!")) b:nested_block {
        stops.pop('tableDataBlock');
        return b;
    }
  / & { return stops.pop('tableDataBlock'); }

/*
 * Line-based block constructs.
 */
block_lines
  = s:sol
    // eat an empty line before the block
    s2:(os:optionalSpaceToken so:sol { return os.concat(so); })?
    bl:block_line {
        return s.concat(s2 || [], bl);
    }

/*
 * Block structures with start-of-line wiki syntax
 */
block_line
  = h
  / list_item
  / st:space_or_newline*
    r:( & [ <{}|!] tl:table_lines { return tl; }
      // tag-only lines should not trigger pre either
      / bts:(bt:block_tag stl:optionalSpaceToken { return bt.concat(stl); })+
        &eolf { return bts; }
      ) {
          return st.concat(r);
      }
  / ! { return stops.counters.nopre; } pi:pre_indent { return pi; }
  / pre
  / // Horizontal rules
    "----" d:"-"*
    // Check if a newline or content follows
    lineContent:( &sol "" { return undefined; } / "" { return true; } ) {
      var dataAttribs = {
        tsr: tsrOffsets(),
        lineContent: lineContent,
      };
      if (d.length > 0) {
        dataAttribs.extra_dashes = d.length;
      }
      return new SelfclosingTagTk('hr', [], dataAttribs);
  }

/*
 * A paragraph. We don't emit 'p' tokens to avoid issues with template
 * transclusions, <p> tags in the source and the like. Instead, we perform
 * some paragraph wrapping on the token stream and the DOM.
 */
paragraph
  = s1:sol s2:sol c:inlineline {
      return s1.concat(s2, c);
  }

br = s:optionalSpaceToken &newline {
    return s.concat([
      new SelfclosingTagTk('br', [], { tsr: tsrOffsets() }),
    ]);
}

inline_breaks
  = & { return inlineBreaks(input, endOffset(), stops); }

pre_start = "<" pre_tag_name [^>]* ">"

inlineline
  = c:(urltext
          / !inline_breaks
            !pre_start
            r:(inline_element / [^\r\n]) { return r; })+ {
      return tu.flattenStringlist(c);
  }

inline_element
  = & '<' r:( nowiki
          / xmlish_tag
          / comment
          ) { return r; }
    / & '{' r:tplarg_or_template { return r; }
    // FIXME: The php parser's replaceInternalLinks2 splits on [[, resulting
    // in sequences with odd number of brackets parsing as text, and sequences
    // with even number of brackets having its innermost pair parse as a
    // wikilink.  For now, we faithfully reproduce what's found there but
    // wikitext, the language, shouldn't be defined by odd tokenizing behaviour
    // in the php parser.  Flagging this for a future cleanup.
    / $('[[' &'[')+
    / & '[' r:( wikilink / extlink ) { return r; }
    / & "'" r:quote { return r; }

/* Headings  */

h = & "=" // guard, to make sure '='+ will match.
          // XXX: Also check to end to avoid inline parsing?
    r:(
     s:$'='+ // moved in here to make s accessible to inner action
     & { return stops.inc('h'); }
     c:nested_block_line
     e:$'='+
     endTPos:("" { return endOffset(); })
     spc:(spaces / comment)*
     &eolf
     {
        stops.dec('h');
        var level = Math.min(s.length, e.length);
        level = Math.min(6, level);
        // convert surplus equals into text
        if (s.length > level) {
            var extras1 = s.substr(0, s.length - level);
            if (c[0].constructor === String) {
                c[0] = extras1 + c[0];
            } else {
                c.unshift(extras1);
            }
        }
        if (e.length > level) {
            var extras2 = e.substr(0, e.length - level);
            var lastElem = lastItem(c);
            if (lastElem.constructor === String) {
                c[c.length - 1] += extras2;
            } else {
                c.push(extras2);
            }
        }

        var tsr = tsrOffsets('start');
        tsr[1] += level;
        return [
          new TagTk('h' + level, [], { tsr: tsr }),
        ].concat(c, [
          new EndTagTk('h' + level, [], { tsr: [endTPos - level, endTPos] }),
          spc,
        ]);
      }
    / & { stops.dec('h'); return false; }
    ) { return r; }


/* Comments */

// The php parser does a straight str.replace(/<!--((?!-->).)*-->/g, "")
// but, as always, things around here are a little more complicated.
//
// We accept the same comments, but because we emit them as HTML comments
// instead of deleting them, we have to encode the data to ensure that
// we always emit a valid HTML5 comment.  See the encodeComment helper
// for further details.

comment
    = '<!--' c:$(!"-->" .)* ('-->' / eof) {
        var data = DU.encodeComment(c);
        return [new CommentTk(data, { tsr: tsrOffsets() })];
    }


// Behavior switches. See:
// https://www.mediawiki.org/wiki/Help:Magic_words#Behavior_switches
behavior_switch
  = bs:$('__' behavior_text '__') {
    return [
      new SelfclosingTagTk('behavior-switch', [ new KV('word', bs) ],
        { tsr: tsrOffsets(), src: bs }),
    ];
  }

// Instead of defining a charset, php's doDoubleUnderscore concats a regexp of
// all the language specific aliases of the behavior switches and then does a
// match and replace. Just be as permissive as possible and let the
// BehaviorSwitchPreprocessor back out of any overreach.
behavior_text = $( !'__' [^'"<~[{\n\r:;\]}|!=] )+


/**************************************************************
 * External (bracketed and autolinked) links
 **************************************************************/

autolink
  = ! { return stops.onStack('extlink'); }
    // this must be a word boundary, so previous character must be non-word
    ! { return /\w/.test(input[endOffset() - 1] || ''); }
  r:(
      // urllink, inlined
      target:autourl {
        var res = [new SelfclosingTagTk('urllink', [new KV('href', target)], { tsr: tsrOffsets() })];
          return res;
      }
    / autoref
    / isbn) { return r; }

extlink
  = ! { return stops.onStack('extlink'); } // extlink cannot be nested
  r:(
        "["
        & { return stops.push('extlink', true); }
        addr:(url_protocol urladdr / "")
        target:(extlink_preprocessor_text / "")
        & {
          // Protocol must be valid and there ought to be at least one
          // post-protocol character.  So strip last char off target
          // before testing protocol.
          var flat = tu.flattenString([addr, target]);
          if (Array.isArray(flat)) {
             // There are templates present, alas.
             return flat.length > 0;
          }
          return Util.isProtocolValid(flat.slice(0, -1), env);
        }
        sp:$( space / unispace )*
        targetOff:( "" { return endOffset(); })
        content:inlineline?
        "]" {
            stops.pop('extlink');
            return [
                new SelfclosingTagTk('extlink', [
                    new KV('href', tu.flattenString([addr, target])),
                    new KV('mw:content', content),
                    new KV('spaces', sp),
                ], {
                    targetOff: targetOff,
                    tsr: tsrOffsets(),
                    contentOffsets: [targetOff, endOffset() - 1],
                }),
            ];
        }
      / br:"[" & { return stops.pop('extlink'); } { return br; }
    ) { return r; }

autoref
  = ref:('RFC' / 'PMID') sp:space_or_nbsp+ identifier:$[0-9]+ end_of_word
{
    var base_urls = {
      'RFC': '//tools.ietf.org/html/rfc%s',
      'PMID': '//www.ncbi.nlm.nih.gov/pubmed/%s?dopt=Abstract',
    };
    var url = tu.sprintf(base_urls[ref], identifier);

    return [
        new SelfclosingTagTk('extlink', [
           new KV('href', tu.sprintf(base_urls[ref], identifier)),
           new KV('mw:content', tu.flattenString([ref, sp, identifier])),
           new KV('typeof', 'mw:ExtLink/' + ref),
        ],
        { stx: "magiclink", tsr: tsrOffsets() }),
    ];
}

isbn
  = 'ISBN' sp:space_or_nbsp+ isbn:(
      [0-9]
      (s:space_or_nbsp_or_dash &[0-9] { return s; } / [0-9])+
      ((space_or_nbsp_or_dash / "") [xX] / "")
    ) isbncode:(
      end_of_word
      {
        // Convert isbn token-and-entity array to stripped string.
        return tu.flattenStringlist(isbn).filter(function(e) {
          return e.constructor === String;
        }).join('').replace(/[^\dX]/ig, '').toUpperCase();
      }
    ) &{
       // ISBNs can only be 10 or 13 digits long (with a specific format)
       return isbncode.length === 10 ||
             (isbncode.length === 13 && /^97[89]/.test(isbncode));
    } {
      return [
        new SelfclosingTagTk('extlink', [
           new KV('href', 'Special:BookSources/' + isbncode),
           new KV('mw:content', tu.flattenString(['ISBN', sp, isbn])),
           new KV('typeof', 'mw:WikiLink/ISBN'),
        ],
        { stx: "magiclink", tsr: tsrOffsets() }),
      ];
}


/* Default URL protocols in MediaWiki (see DefaultSettings). Normally
 * these can be configured dynamically. */

url_protocol =
    & { return Util.isProtocolValid(input.substr(endOffset()), env); }
    p:$( '//' / [A-Za-z] [-A-Za-z0-9+.]* ':' '//'? ) { return p; }

// no punctuation, and '{<' to trigger directives
no_punctuation_char = [^ :\]\[\r\n"'<>\x00-\x20\x7f,.&%\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000{]

// this is the general url rule
// on the PHP side, the path part matches EXT_LINK_URL_CLASS
// which is '[^][<>"\\x00-\\x20\\x7F\p{Zs}]'
// the 's' and 'r' pieces below match the characters in
// EXT_LINK_URL_CLASS which aren't included in no_punctuation_char
url "url"
  = proto:url_protocol
    addr:(urladdr / "")
    path:(  ( !inline_breaks
              c:no_punctuation_char
              { return c; }
            )
            / s:[.:,']  { return s; }
            / comment
            / tplarg_or_template
            / ! ( "&" ( [lL][tT] / [gG][tT] ) ";" )
                r:(
                    & "&" he:htmlentity { return he; }
                  / [&%{]
                ) { return r; }
         )*
         // Must be at least one character after the protocol
         & { return addr.length > 0 || path.length > 0; }
{
    return tu.flattenString([proto, addr].concat(path));
}

// this is the somewhat-restricted rule used in autolinks
// See Parser::doMagicLinks and Parser.php::makeFreeExternalLink.
// The `path` portion matches EXT_LINK_URL_CLASS, as in the general
// url rule.  As in PHP, we do some fancy fixup to yank out
// trailing punctuation, perhaps including parentheses.
// The 's' and 'r' pieces match the characters in EXT_LINK_URL_CLASS
// which aren't included in no_punctuation_char
autourl
  = &{ return stops.push('autourl', { sawLParen: false }); }
    ! '//' // protocol-relative autolinks not allowed (T32269)
    r:(
    proto:url_protocol
    addr:(urladdr / "")
    path:(  ( !inline_breaks
              ! "("
              c:no_punctuation_char
              { return c; }
            )
            / "(" { stops.onStack('autourl').sawLParen = true; return "("; }
            / [.:,]
            / $(['] ![']) // single quotes are ok, double quotes are bad
            / comment
            / tplarg_or_template
            / ! ( rhe:raw_htmlentity &{ return /^[<>\u00A0]$/.test(rhe); } )
                r:(
                    & "&" he:htmlentity { return he; }
                  / [&%{]
                ) { return r; }
         )*
{
    // as in Parser.php::makeFreeExternalLink, we're going to
    // yank trailing punctuation out of this match.
    var url = tu.flattenStringlist([proto, addr].concat(path));
    // only need to look at last element; HTML entities are strip-proof.
    var last = lastItem(url);
    var trim = 0;
    if (last && last.constructor === String) {
      var strip = ',;\\.:!?';
      if (!stops.onStack('autourl').sawLParen) {
        strip += ')';
      }
      strip = new RegExp('[' + Util.escapeRegExp(strip) + ']*$');
      trim = strip.exec(last)[0].length;
      url[url.length - 1] = last.slice(0, last.length - trim);
    }
    url = tu.flattenStringlist(url);
    if (url.length === 1 && url[0].constructor === String && url[0].length <= proto.length) {
      return null; // ensure we haven't stripped everything: T106945
    }
    peg$currPos -= trim;
    stops.pop('autourl');
    return url;
} ) &{ return r !== null; } {return r; }
    / &{ return stops.pop('autourl'); }

// This is extracted from EXT_LINK_ADDR in Parser.php: a simplified
// expression to match an IPv6 address.  The IPv4 address and "at least
// one character of a host name" portions are punted to the `path`
// component of the `autourl` and `url` productions
urladdr
  = $( "[" [0-9A-Fa-f:.]+ "]" )

/**************************************************************
 * Templates, -arguments and wikilinks
 **************************************************************/

/*
 * Precedence: template arguments win over templates. See
 * http://www.mediawiki.org/wiki/Preprocessor_ABNF#Ideal_precedence
 * 4: {{{{·}}}} → {·{{{·}}}·}
 * 5: {{{{{·}}}}} → {{·{{{·}}}·}}
 * 6: {{{{{{·}}}}}} → {{{·{{{·}}}·}}}
 * 7: {{{{{{{·}}}}}}} → {·{{{·{{{·}}}·}}}·}
 */
tplarg_or_template
    = & {
      // Refuse to recurse beyond 40 levels. Default in the PHP parser
      // is $wgMaxTemplateDepth = 40; This is to prevent crashing from
      // buggy wikitext with lots of unclosed template calls, as in
      // eswiki/Usuario:C%C3%A1rdenas/PRUEBAS?oldid=651094
      if (stops.onCount('templatedepth') === undefined ||
          stops.onCount('templatedepth') < 40) {
        return stops.inc('templatedepth');
      } else {
        return false;
      }
    }
    r:( &('{{' &('{{{'+ !'{') tplarg) a:template { return a; }
      / a:$('{' &('{{{'+ !'{'))? b:tplarg { return [a].concat(b); }
      / a:$('{' &('{{' !'{'))? b:template { return [a].concat(b); }
    ) {
      stops.dec('templatedepth');
      return r;
    }
    / & { return stops.dec('templatedepth'); }

tplarg_or_template_or_bust "tplarg_or_template_or_bust"
    = r:(tplarg_or_template / .)+ { return tu.flattenIfArray(r); }

template
  = "{{" nl_comment_space*
    target:template_param_value
    params:(nl_comment_space* "|"
                r:( p0:("" { return endOffset(); })
                    v:nl_comment_space*
                    p:("" { return endOffset(); })
                    & "|"
                    { return new KV('', tu.flattenIfArray(v), [p0, p0, p0, p]); } // empty argument
                    / template_param
                  ) { return r; }
            )*
    nl_comment_space*
    "}}" {
      // Insert target as first positional attribute, so that it can be
      // generically expanded. The TemplateHandler then needs to shift it out
      // again.
      params.unshift(new KV(tu.flattenIfArray(target.tokens), '', target.srcOffsets));
      var obj = new SelfclosingTagTk('template', params, { tsr: tsrOffsets(), src: text() });
      return obj;
    } / $('{{' space_or_newline+ '}}')

tplarg
  = "{{{"
    name:template_param_value?
    params:( nl_comment_space*
              '|' nl_comment_space*
               r:(
                    &'}}}' { return new KV('', ''); }
                    / template_param
               ) { return r; }
           )*
    nl_comment_space*
    "}}}" {
      if (name) {
        params.unshift(new KV(tu.flattenIfArray(name.tokens), '', name.srcOffsets));
      } else {
        params.unshift(new KV('', ''));
      }
      var obj = new SelfclosingTagTk('templatearg', params, { tsr: tsrOffsets(), src: text() });
      return obj;
  }

template_param
  = name:template_param_name
    val:(
        kEndPos:("" { return endOffset(); })
        optionalSpaceToken
        "="
        vStartPos:("" { return endOffset(); })
        optionalSpaceToken
        tpv:template_param_value? {
            return { kEndPos: kEndPos, vStartPos: vStartPos, value: (tpv && tpv.tokens) || [] };
        }
    )? {
      if (val !== null) {
          if (val.value !== null) {
            return new KV(name, tu.flattenIfArray(val.value), [startOffset(), val.kEndPos, val.vStartPos, endOffset()]);
          } else {
            return new KV(tu.flattenIfArray(name), '', [startOffset(), val.kEndPos, val.vStartPos, endOffset()]);
          }
      } else {
        return new KV('', tu.flattenIfArray(name), [startOffset(), startOffset(), startOffset(), endOffset()]);
      }
    }
  // empty parameter
  / & [|}] {
    return new KV('', '', [startOffset(), startOffset(), startOffset(), endOffset()]);
  }

template_param_name
  = & { return stops.push('equal', true); }
    tpt:(template_param_text / &'=' { return ''; })
    {
        stops.pop('equal');
        return tpt;
    }

  / & { return stops.pop('equal'); }

template_param_value
  = & { stops.inc('nopre'); return stops.push('equal', false); }
    tpt:template_param_text
    {
        stops.dec('nopre');
        stops.pop('equal');
        return { tokens: tpt, srcOffsets: tsrOffsets() };
    }
  / & { stops.dec('nopre'); return stops.pop('equal'); }

template_param_text
  = & { // re-enable tables within template parameters
        stops.push('table', false);
        stops.push('extlink', false);
        stops.push('templateArg', true);
        stops.push('tableCellArg', false);
        return stops.inc('template');
    }
    il:(nested_block / newlineToken)+ {
        stops.pop('table');
        stops.pop('extlink');
        stops.pop('templateArg');
        stops.pop('tableCellArg');
        stops.dec('template');
        // il is guaranteed to be an array -- so, tu.flattenIfArray will
        // always return an array
        var r = tu.flattenIfArray(il);
        if (r.length === 1 && r[0].constructor === String) {
            r = r[0];
        }
        return r;
    }
  / & { stops.pop('table');
        stops.pop('extlink');
        stops.pop('templateArg');
        stops.pop('tableCellArg');
        return stops.dec('template');
    }

wikilink_content
  = lcs:( pipe startPos:("" { return endOffset(); }) lt:link_text? {
        var maybeContent = new KV('mw:maybeContent', lt, [startPos, endOffset()]);
        maybeContent.vsrc = input.substring(startPos, endOffset());
        return maybeContent;
    } ) + {
        if (lcs.length === 1 && lcs[0].v === null) {
            return { content: [], pipetrick: true };
        } else {
            return { content: lcs };
        }
    }

// TODO: handle link prefixes as in al[[Razi]]
wikilink
  = "[["
    ! url
    //target:link_target
    // XXX: disallow pipe!
    target:wikilink_preprocessor_text?
    tpos:("" { return endOffset(); })
    lcontent:wikilink_content?
    "]]"
  {
      if (lcontent === null) {
          lcontent = { content: [] };
      }

      if (target === null || lcontent.pipetrick) {
        return [text()];
      }

      var obj = new SelfclosingTagTk('wikilink');
      var textTokens = [];
      var hrefKV = new KV('href', target);
      hrefKV.vsrc = input.substring(startOffset() + 2, tpos);
      // XXX: Point to object with path, revision and input information
      // obj.source = input;
      obj.attribs.push(hrefKV);
      obj.attribs = obj.attribs.concat(lcontent.content);
      obj.dataAttribs = {
          tsr: tsrOffsets(),
          src: text(),
      };
      return [obj];
  }

// Tables are allowed inside image captions.
link_text_fragment
  = c:((sol full_table_in_link_caption)
       / urltext
       / (!inline_breaks
          !pre_start
          r:( inline_element / '[' text_char+ ']' / . ) { return r; }
         )
    )+ {
      return tu.flattenStringlist(c);
  }

link_text
  = & { return stops.push('linkdesc', true); }
    h:link_text_fragment
    // 'equal' syntaxFlag is set for links in template parameters. Consume the
    // '=' here.
    hs:( '=' link_text_fragment )?
    {
        stops.pop('linkdesc');
        if (hs !== null) {
            return h.concat(hs);
        } else {
            return h;
        }
    }
  / & { return stops.pop('linkdesc'); }


/* Generic quote rule for italic and bold, further processed in a token
 * stream transformation in doQuotes. Relies on NlTk tokens being emitted
 * for each line of text to balance quotes per line.
 *
 * We are not using a simple pair rule here as we need to support mis-nested
 * bolds/italics and MediaWiki's special heuristics for apostrophes, which are
 * all not context free. */
quote = quotes:$("''" "'"*) {
    // sequences of four or more than five quotes are assumed to start
    // with some number of plain-text apostrophes.
    var plainticks = 0;
    var result = [];
    if (quotes.length === 4) {
        plainticks = 1;
    } else if (quotes.length > 5) {
        plainticks = quotes.length - 5;
    }
    if (plainticks > 0) {
        result.push(quotes.substring(0, plainticks));
    }
    // mw-quote token Will be consumed in token transforms
    var tsr = tsrOffsets();
    tsr[0] += plainticks;
    var mwq = new SelfclosingTagTk('mw-quote', [], { tsr: tsr });
    mwq.value = quotes.substring(plainticks);
    result.push(mwq);
    return result;
}


/***********************************************************
 * Pre and xmlish tags
 ***********************************************************/

// Indented pre blocks differ from their non-indented (purely tag-based)
// cousins by having their contents parsed.
pre_indent
  = 
  // FIXME: Disabled for now. This is T108216.
  // pre_indent_in_tags
  // /
    l:pre_indent_line
    // keep consuming indented lines unless they start a table
    ls:(s:sol
        !(space* "{|")
        pl:pre_indent_line {
              return s.concat(pl);
        }
    )*
  {
      return l.concat(ls);
  }

pre_tag_name =
  tag:"pre"i !tag_name_chars {
    return tag;
  }

// An indented pre block that is surrounded with pre tags. The pre tags are
// used directly.
// XXX gwicke: check if the first line is not indented, and round-trip spaces;
// possibly merge with the regular 'pre' rule.
// FIXME: fix tag end position
pre_indent_in_tags
  = & { return stops.inc('pre'); }
    s:spaces // XXX: capture space for round-tripping
    "<" pre_tag_name
    attribs:generic_newline_attributes
    ">"
    l:nested_block_line
    ls:(sol pre_indent_line)*
    "</" pre_tag_name ">"
  {
    stops.dec('pre');
    var ret = [ new TagTk('pre', attribs, { tsr: tsrOffsets('start') }) ];
    // ls will always be an array
    return ret.concat(l, tu.flattenIfArray(ls), [ new EndTagTk('pre') ]);
  }
  / & { return stops.dec('pre'); }

// Don't recognize tabs
pre_indent_line = " " l:nested_block_line {
    return [' '].concat(l);
}

/*
 * Pre blocks defined using non-indented HTML tags only parse nowiki tags and
 * html entities inside them, and convert other content to verbatim text.
 * Nowiki inside pre is not functionally needed, but supported for backwards
 * compatibility.
 *
 * TODO: add entity support!
 */
pre
  = & { return stops.inc('pre'); }
    "<" pre_tag_name
    attribs:generic_newline_attributes
    space*
    endpos:(">" { return endOffset(); })
    // MediaWiki <pre> is special in that it converts all pre content to plain
    // text.
    ts:(    newlineToken
                / (htmlentity / [^&<]+)+
                / nowiki
                / !("</" pre_tag_name ">") t2:(htmlentity / .) { return t2; })*
    ("</" pre_tag_name ">" / eof) {
        stops.dec('pre');
        // return nowiki tags as well?

        // Emit as SelfclosingTag in order to avoid the nested pre problem in
        // the PreHandler.
        attribs.push(new KV('property', 'mw:html'));
        attribs.push(new KV('content', tu.flattenStringlist(ts)));
        return [
            new SelfclosingTagTk('pre', attribs, {
                tsr: tsrOffsets(),
                endpos: endpos,
            }),
        ];

    }
  / "</" pre_tag_name ">" { stops.dec('pre'); return "</pre>"; }
  // if this is still preish, emit as a string
  // necessary to work with the pre_start lookaheads
  / p:('<' pre_tag_name) {
      stops.dec('pre');
      return tu.flattenStringlist(p);
    }
  / & { return stops.dec('pre'); }

/* -----------------------------------------------------------------------
 * Extension tags should be parsed with higher priority than anything else.
 * The trick we use is to strip out the content inside a matching tag-pair
 * and not tokenize it. The content, if it needs to parsed (for example,
 * for <ref>, <*include*> tags), is parsed in a fresh tokenizer context
 * which means any error correction that needs to happen is restricted to
 * the scope of the extension content and doesn't spill over to the higher
 * level.  Ex: <math><!--foo</math>.
 *
 * This trick also lets us prevent extension content (that don't accept WT)
 * from being parsed as wikitext (Ex: <math>\frac{foo\frac{bar}}</math>)
 * We don't want the "}}" being treated as a template closing tag and closing
 * outer templates.
 * ----------------------------------------------------------------------- */

xmlish_tag =
    t:generic_tag & {
        var tagName = t.name.toLowerCase();
        var isHtmlTag = Util.isHTMLElementName(tagName);
        var isInstalledExt = env.conf.wiki.extensionTags.has(tagName);
        var isIncludeTag = tagName === 'includeonly' ||
                tagName === 'noinclude' || tagName === 'onlyinclude';
        return isHtmlTag || isInstalledExt || isIncludeTag;
    } {
        var tagName = t.name.toLowerCase();
        var isHtmlTag = Util.isHTMLElementName(tagName);
        var isInstalledExt = env.conf.wiki.extensionTags.has(tagName);
        var isIncludeTag = tagName === 'includeonly' ||
                tagName === 'noinclude' || tagName === 'onlyinclude';
        var dp = t.dataAttribs;
        var skipLen = 0;

        // Extensions have higher precedence when they shadow html tags.
        if (!(isInstalledExt || isIncludeTag)) {
            return t;
        }

        switch (t.constructor) {
        case EndTagTk:
            return t;
        case SelfclosingTagTk:
            dp.src = input.substring(dp.tsr[0], dp.tsr[1]);
            dp.tagWidths = [dp.tsr[1] - dp.tsr[0], 0];
            if (isIncludeTag) {
                return t;
            }
            break;
        case TagTk:
            var tsr0 = dp.tsr[0];
            var endTagRE = new RegExp("^[\\s\\S]*?(</\\s*" + tagName + "\\s*>)", "mi");
            var restOfInput = input.substring(tsr0);
            var tagContent = restOfInput.match(endTagRE);

            if (!tagContent) {
                dp.src = input.substring(dp.tsr[0], dp.tsr[1]);
                dp.tagWidths = [dp.tsr[1] - dp.tsr[0], 0];
                if (isIncludeTag) {
                    return t;
                } else {
                    // This is undefined behaviour.  The php parser currently
                    // returns a tag here as well, which results in unclosed
                    // extension tags that shadow html tags falling back to
                    // their html equivalent.  The sanitizer will take care
                    // of converting to text where necessary.  We do this to
                    // simplify `hasWikitextTokens` when escaping wikitext,
                    // which wants these as tokens because it's otherwise
                    // lacking in context.
                    return t;  // not text()
                }
            }

            var extSrc = tagContent[0];
            var endTagWidth = tagContent[1].length;

            // FIXME: This should be removed in favour of a native parser function
            // for `tag`, which invokes the extension handler directly.
            if (tagName === 'ref') {
                // Support 1-level nesting of <ref> tags during tokenizing.
                // <ref> tags are the exception to the rule (no nesting of ext tags)
                //
                // Expand extSrc as long as there is a <ref> tag found in the
                // extension source body.
                var s = extSrc.substring(endOffset() - tsr0);
                while (s && s.match(new RegExp("<" + tagName + "[^<>]*>"))) {
                    tagContent = restOfInput.substring(extSrc.length).match(endTagRE);
                    if (tagContent) {
                        s = tagContent[0];
                        endTagWidth = tagContent[1].length;
                        extSrc += s;
                    } else {
                        s = null;
                    }
                }
            }

            // Extension content source
            dp.src = extSrc;
            dp.tagWidths = [endOffset() - tsr0, endTagWidth];

            skipLen = extSrc.length - dp.tagWidths[0] - dp.tagWidths[1];

            // If the xml-tag is a known installed (not native) extension,
            // skip the end-tag as well.
            if (isInstalledExt) {
                skipLen += endTagWidth;
            }
            break;
        default:
            console.assert(false, 'Should not be reachable.');
        }

        peg$currPos += skipLen;

        if (isInstalledExt) {
            // update tsr[1] to span the start and end tags.
            dp.tsr[1] = endOffset();  // was just modified above
            return new SelfclosingTagTk('extension', [
                new KV('typeof', 'mw:Extension'),
                new KV('name', tagName),
                new KV('about', env.newAboutId()),
                new KV('source', dp.src),
                new KV('options', t.attribs),
            ], dp);
        } else if (isIncludeTag) {
            // Parse ext-content, strip eof, and shift tsr
            var extContent = dp.src.substring(dp.tagWidths[0], dp.src.length - dp.tagWidths[1]);
            var extContentToks = (new PegTokenizer(env)).tokenizeSync(extContent);
            if (dp.tagWidths[1] > 0) {
                extContentToks = Util.stripEOFTkfromTokens(extContentToks);
            }
            Util.shiftTokenTSR(extContentToks, dp.tsr[0] + dp.tagWidths[0]);
            return [t].concat(extContentToks);
        } else {
            console.assert(false, 'Should not be reachable.');
        }
    }

/*
 * Nowiki treats anything inside it as plain text. It could thus also be
 * defined as an extension that returns its raw input text, possibly wrapped
 * in a span for round-trip information. The special treatment for nowiki in
 * pre blocks would still remain in the grammar though, so overall handling it
 * all here is cleaner.
 */

nowiki_tag_name =
  tag:"nowiki"i !tag_name_chars {
    return tag;
  }

nowiki
  = "<" nowiki_tag_name space* ">"
    startTagEndPos:("" { return endOffset(); })
    nc:nowiki_content
    endTagStartPos:("" { return endOffset(); })
    "</" nowiki_tag_name space* ">" {
        return [
            new TagTk('span', [{ k: 'typeof', v: 'mw:Nowiki' }],
              { tsr: [startOffset(), startTagEndPos] }),
        ].concat(nc, [
            new EndTagTk('span', [{ k: 'typeof', v: 'mw:Nowiki' }],
              { tsr: [endTagStartPos, endOffset()] }),
        ]);
    }
  // nowiki fallback: source-based round-tripping of <nowiki />.
  / "<" nowiki_tag_name space* "/" space* ">" {
      return Util.placeholder(null, {
        src: text(),
        tsr: tsrOffsets(),
      });
    }
  // nowiki fallback: source-based round-tripping
  // of unbalanced nowiki tags that are treated as text.
  / ! { return stops.counters.pre > 0; }
    "<" "/"? nowiki_tag_name space* "/"? space* ">" {
      var nowiki = text();
      return Util.placeholder(nowiki, {
        src: nowiki,
        tsr: tsrOffsets('start'),
      }, { tsr: tsrOffsets('end') });
    }

// Should abort the nowiki match:
//   <pre><nowiki></pre></nowiki>
// Should allow the </pre> in nowiki:
//   <nowiki></pre></nowiki>
pre_break = & ( "</pre>" & { return stops.counters.pre > 0; } )

nowiki_content
  = ts:(   (htmlentity / [^&<]+)+
           / "<pre" p0:optionalSpaceToken p1:[^>]* ">" p2:nowiki_content "</pre>" {
                 return ["<pre"].concat(p0, p1, [">"], p2, ["</pre>"]).join('');
               }
           / (!pre_break !("</" nowiki_tag_name space* ">") c:(htmlentity / .) {
               return c;
           })
       )* {
            // return nowiki tags as well?
            return tu.flattenStringlist(ts);
          }

/* Generic XML-like tags
 *
 * These also cover extensions (including Cite), which will hook into the
 * token stream for further processing. The content of extension tags is
 * parsed as regular inline, but the source positions of the tag are added
 * to allow reconstructing the unparsed text from the input. */

// See http://www.w3.org/TR/html5/syntax.html#tag-open-state and
// following paragraphs.
tag_name_chars = [^\t\n\v />\0]
tag_name = $([A-Za-z] tag_name_chars*)

generic_tag
  = & {
      // By the time we get to `doTableStuff` in the php parser, we've already
      // safely encoded element attributes. See 55313f4e in core.
      // FIXME: Also need to handle the || case here, which probably means
      // pushing 'table'. See the failing test, "! and || in element attributes
      // should not be parsed as <th>/<td>".
      return stops.push('tableCellArg', false);
    }
    "<"
    end:"/"? name:tag_name
    attribs:generic_newline_attributes
    space_or_newline* // No need to preserve this -- canonicalize on RT via dirty diff
    selfclose:"/"?
    bad_ws:space* // No need to preserve this -- canonicalize on RT via dirty diff
    ">" {
        stops.pop('tableCellArg');
        var lcName = name.toLowerCase();
        var isVoidElt = Util.isVoidElement(lcName) ? true : null;
        // Support </br>
        var broken = false;
        if (lcName === 'br' && end) {
            broken = true;
            end = null;
        }

        var res = tu.buildXMLTag(name, lcName, attribs, end, selfclose || isVoidElt, tsrOffsets());

        // change up data-attribs in one scenario
        // void-elts that aren't self-closed ==> useful for accurate RT-ing
        if (selfclose === null && isVoidElt) {
            res.dataAttribs.selfClose = undefined;
            res.dataAttribs.noClose = true;
        }
        if (broken || bad_ws.length > 0) {
            res.dataAttribs.brokenHTMLTag = true;
        }
        return res;
    }
    / & { return stops.pop('tableCellArg'); }

// A generic attribute that can span multiple lines.
generic_newline_attribute
  = s:space_or_newline*
    namePos0:("" { return endOffset(); })
    name:generic_attribute_name
    namePos:("" { return endOffset(); })
    vd:(space_or_newline* "=" v:generic_att_value? { return v; })?
{
    // NB: Keep in sync w/ table_attibute
    var res;
    // Encapsulate protected attributes.
    if (typeof name === 'string') {
        name = tu.protectAttrs(name);
    }
    if (vd !== null) {
        res = new KV(name, vd.value, [namePos0, namePos, vd.srcOffsets[0], vd.srcOffsets[1]]);
        res.vsrc = input.substring(vd.srcOffsets[0], vd.srcOffsets[1]);
    } else {
        res = new KV(name, '');
    }
    if (Array.isArray(name)) {
        res.ksrc = input.substring(namePos0, namePos);
    }
    return res;
}

// A single-line attribute.
table_attribute
  = s:optionalSpaceToken
    namePos0:("" { return endOffset(); })
    name:table_attribute_name
    namePos:("" { return endOffset(); })
    vd:(optionalSpaceToken "=" v:table_att_value? { return v; })?
{
    // NB: Keep in sync w/ generic_newline_attribute
    var res;
    // Encapsulate protected attributes.
    if (typeof name === 'string') {
        name = tu.protectAttrs(name);
    }
    if (vd !== null) {
        res = new KV(name, vd.value, [namePos0, namePos, vd.srcOffsets[0], vd.srcOffsets[1]]);
        res.vsrc = input.substring(vd.srcOffsets[0], vd.srcOffsets[1]);
    } else {
        res = new KV(name, '');
    }
    if (Array.isArray(name)) {
        res.ksrc = input.substring(namePos0, namePos);
    }
    return res;
}

// The arrangement of chars is to emphasize the split between what's disallowed
// by html5 and what's necessary to give directive a chance.
// See: http://www.w3.org/TR/html5/syntax.html#attributes-0
generic_attribute_name
  = r:( $[^ \t\r\n\0/=>"'<&{}\-]+
        / !inline_breaks
          // \0/=>"' is the html5 attribute name set we do not want.
          t:( directive / !( space_or_newline / [\0/=>"'] ) c:. { return c; }
        ) { return t; }
      )+ {
    return tu.flattenString(r);
  }

// Also accept these chars in a wikitext table or tr attribute name position.
// They are normally not matched by the table_attribute_name.
broken_table_attribute_name_char = c:[\0/=>"'] { return new KV(c, ''); }

// Same as generic_attribute_name, except for accepting tags and wikilinks.
// (That doesn't make sense (ie. match php) in the generic case.)
// We also give a chance to break on !, |, and \[ (see T2553).
table_attribute_name
  = r:( $[^ \t\r\n\0/=>"'<&{}\-!|\[]+
        / !inline_breaks
          // \0/=>"' is the html5 attribute name set we do not want.
          t:(   $wikilink
              / directive
              // Accept insane tags-inside-attributes as attribute names.
              // The sanitizer will strip and shadow them for roundtripping.
              // Example: <hiddentext>generated with.. </hiddentext>
              / &generic_tag nb:nested_block_line
                // `nested_block_line` can return zero or more blocks.
                // Assure that we've got at least one, otherwise that plus
                // below is trouble.
                &{ return nb.length > 0; } { return nb; }
              / !( space_or_newline / [\0/=>"'] ) c:. { return c; }
        ) { return t; }
      )+ {
    return tu.flattenString(r);
  }

// Attribute value, quoted variants can span multiple lines.
// Missing end quote: accept /> look-ahead as heuristic.
// These need to be kept in sync with the attribute_preprocessor_text_*
generic_att_value
  = s:$(space_or_newline* "'") t:attribute_preprocessor_text_single? q:$("'" / &('/'? '>')) {
      return tu.getAttrVal(t, startOffset() + s.length, endOffset() - q.length);
    }
  / s:$(space_or_newline* '"') t:attribute_preprocessor_text_double? q:$('"' / &('/'? '>')) {
      return tu.getAttrVal(t, startOffset() + s.length, endOffset() - q.length);
    }
  / s:$space_or_newline* t:attribute_preprocessor_text &(space_or_newline / eof / '/'? '>') {
      return tu.getAttrVal(t, startOffset() + s.length, endOffset());
    }

// Attribute value, restricted to a single line.
// Missing end quote: accept |, !!, \r, and \n look-ahead as heuristic.
// These need to be kept in sync with the table_attribute_preprocessor_text_*
table_att_value
  = s:$(space* "'") t:table_attribute_preprocessor_text_single? q:$("'" / &('!!' / [|\r\n])) {
      return tu.getAttrVal(t, startOffset() + s.length, endOffset() - q.length);
    }
  / s:$(space* '"') t:table_attribute_preprocessor_text_double? q:$('"' / &('!!' / [|\r\n])) {
      return tu.getAttrVal(t, startOffset() + s.length, endOffset() - q.length);
    }
  / s:$space* t:table_attribute_preprocessor_text &(space_or_newline/ eof / '!!' / '|') {
      return tu.getAttrVal(t, startOffset() + s.length, endOffset());
    }

/*
 * A variant of generic_tag, but also checks if the tag name is a block-level
 * tag as defined in
 * http://www.w3.org/TR/html5/syntax.html#tag-open-state and
 * following paragraphs.
 */
block_tag
  = "<" end:"/"?
    name:$(tn:tag_name & {
      var lcTn = tn.toLowerCase();
      return lcTn !== "pre" && lcTn !== "hr" &&
        constants.HTML.BlockTags.has(tn.toUpperCase());
    })
    attribs:generic_newline_attributes
    space_or_newline*
    selfclose:"/"?
    ">" {
      return [
        tu.buildXMLTag(name, name.toLowerCase(), attribs, end, selfclose,
          tsrOffsets()),
      ];
    }


/*********************************************************
 *   Lists
 *********************************************************/
list_item = dtdd / hacky_dl_uses / li

li = bullets:list_char+
     c:nested_block_line
     // The inline_break is to check if we've hit a template end delimiter.
     &(eolf / inline_breaks)
{
    if (c === null) {
        c = [];
    }
    // Leave bullets as an array -- list handler expects this
    var tsr = tsrOffsets('start');
    tsr[1] += bullets.length;
    var li = new TagTk('listItem', [], { tsr: tsr });
    li.bullets = bullets;
    return [ li, c ];
}

/*
 * This rule is required to support wikitext of this form
 *   ::{|border="1"|foo|bar|baz|}
 * where the leading colons are used to indent the entire table.
 * This hack was added back in 2006 in commit
 * a0746946312b0f1eda30a2c793f5f7052e8e5f3a based on a patch by Carl
 * Fürstenberg.
 */
hacky_dl_uses = bullets:":"+
               tbl:(table_lines (sol table_lines)*)
               s:space* // Do we really need to RT this?
               &comment_space_eolf
{
    // Leave bullets as an array -- list handler expects this
    var tsr = tsrOffsets('start');
    tsr[1] += bullets.length;
    var li = new TagTk('listItem', [], { tsr: tsr });
    li.bullets = bullets;
    return tu.flattenIfArray([li, tbl || [], s || []]);
}

dtdd
  = bullets:(!(";" !list_char) lc:list_char { return lc; })*
    ";"
    & {return stops.inc('colon');}
    c:nested_block_line
    cpos:(":" { return endOffset(); })
    // Fortunately dtdds cannot be nested, so we can simply set the flag
    // back to 0 to disable it.
    & { stops.counters.colon = 0; return true;}
    d:nested_block_line?
    &eolf {
        // Leave bullets as an array -- list handler expects this
        // TSR: +1 for the leading ";"
        var numBullets = bullets.length + 1;
        var tsr = tsrOffsets('start');
        tsr[1] += numBullets;
        var li1 = new TagTk('listItem', [], { tsr: tsr });
        li1.bullets = bullets.slice();
        li1.bullets.push(";");
        // TSR: -1 for the intermediate ":"
        var li2 = new TagTk('listItem', [], { tsr: [cpos - 1, cpos], stx: 'row' });
        li2.bullets = bullets.slice();
        li2.bullets.push(":");

        return [ li1 ].concat(c, [ li2 ], d || []);
    }
  // Fall-back case to clear the colon flag
  / & { stops.counters.colon = 0; return false; }


list_char = [*#:;]



/******************************************************************************
 * Tables
 * ------
 * Table rules are geared to support independent parsing of fragments in
 * templates (the common table start / row / table end use case). The tokens
 * produced by these fragments then match up to a table while building the
 * DOM tree. For similar reasons, table rows do not emit explicit end tag
 * tokens.
 *
 * The separate table_lines rule is faster than moving those rules
 * directly to block_lines.
 *
 * Notes about the full_table_in_link_caption rule
 * -----------------------------------------------------
 * However, for link-tables, we have introduced a stricter parse wherein
 * we require table-start and table-end tags to not come from a template.
 * In addition, this new rule doesn't accept fosterable-content in
 * the table unlike the more lax (sol table_lines)+ rule.
 *
 * This is the best we can do at this time since we cannot distinguish
 * between table rows and image options entirely in the tokenizer.
 *
 * Consider the following examples:
 *
 * Example 1:
 *
 * [[Image:Foo.jpg|left|30px|Example 1
 * {{This-template-returns-a-table-start-tag}}
 * |foo
 * {{This-template-returns-a-table-end-tag}}
 * ]]
 *
 * Example 2:
 *
 * [[Image:Foo.jpg|left|30px|Example 1
 * {{echo|a}}
 * |foo
 * {{echo|b}}
 * ]]
 *
 * So, we cannot know a priori (without preprocessing or fully expanding
 * all templates) if "|foo" in the two examples is a table cell or an image
 * option. This is a limitation of our tokenizer-based approach compared to
 * the preprocessing-based approach of the PHP parser.
 *
 * Given this limitation, we are okay forcing a full-table context in
 * link captions (if necessary, we can relax the fosterable-content requirement
 * but that is broken wikitext anyway, so we can force that edge-case wikitext
 * to get fixed by rejecting it).
 ******************************************************************************/

full_table_in_link_caption
  = (! inline_breaks / & '{{!}}' )
    r:(
        & { return stops.push('table', true); }
        tbl:(
            table_start_tag optionalNewlines
            (sol table_content_line optionalNewlines)*
            sol table_end_tag)
        {
            stops.pop('table');
            return tbl;
        }
      / & { return stops.pop('table'); }
    ) { return r; }

table_lines
  = (! inline_breaks / & '{{!}}' )
    r:(
        & { return stops.push('table', true); }
        tl:table_line
        nls:optionalNewlines
        {
            stops.pop('table');
            return tl.concat(nls);
        }
      / & { return stops.pop('table'); }
    ) { return r; }

// This rule assumes start-of-line position!
table_line
  = table_start_tag
  / table_content_line
  / table_end_tag

table_content_line = (space / comment)* (
    table_heading_tags
    / table_row_tag
    / table_data_tags
    / table_caption_tag
  )

table_start_tag "table_start_tag"
  = sc:(space / comment)* startPos:("" { return endOffset(); }) b:"{" p:pipe
    // ok to normalize away stray |} on rt (see T59360)
    & { return stops.push('table', false); }
    ta:table_attributes
    tsEndPos:("" { stops.pop('table'); return endOffset(); })
    {
        var coms = tu.popComments(ta);
        if (coms) {
          tsEndPos = coms.commentStartPos;
        }

        var da = { tsr: [startPos, tsEndPos] };
        if (p !== "|") {
            // Variation from default
            da.startTagSrc = b + p;
        }

        sc.push(new TagTk('table', ta, da));
        if (coms) {
          sc = sc.concat(coms.buf);
        }
        return sc;
    }

// FIXME: Not sure if we want to support it, but this should allow columns.
table_caption_tag
    // avoid recursion via nested_block_in_table
  = ! { return stops.onStack('tableDataBlock'); }
    p:pipe "+"
    args:row_syntax_table_args?
    tagEndPos:("" { return endOffset(); })
    c:nested_block_in_table* {
        return tu.buildTableTokens("caption", "|+", args, [startOffset(), tagEndPos], endOffset(), c, true);
    }

table_row_tag
  = // avoid recursion via nested_block_in_table
    ! { return stops.onStack('tableDataBlock'); }
    p:pipe dashes:$"-"+
    & { return stops.push('table', false); }
    a:table_attributes
    tagEndPos:("" { stops.pop('table'); return endOffset(); })
    // handle tables with missing table cells after a row
    td:implicit_table_data_tag?
    {
        var coms = tu.popComments(a);
        if (coms) {
          tagEndPos = coms.commentStartPos;
        }

        var da = {
          tsr: [ startOffset(), tagEndPos ],
          startTagSrc: p + dashes,
        };

        // We rely on our tree builder to close the row as needed. This is
        // needed to support building tables from fragment templates with
        // individual cells or rows.
        var trToken = new TagTk('tr', a, da);

        var res = [ trToken ];
        if (coms) {
          res = res.concat(coms.buf);
        }
        if (td) {
          res = res.concat(td);
        }
        return res;
    }

tds
  = ( pp:( pipe_pipe / p:pipe & row_syntax_table_args { return p; } )
      tdt:table_data_tag {
        var da = tdt[0].dataAttribs;
        da.stx_v = "row";
        da.tsr[0] = da.tsr[0] - pp.length; // include "||"
        if (pp !== "||" || (da.startTagSrc && da.startTagSrc !== pp)) {
          // Variation from default
          da.startTagSrc = pp + (da.startTagSrc ? da.startTagSrc.substring(1) : '');
        }
        return tdt;
      }
    )*

table_data_tags
    // avoid recursion via nested_block_in_table
  = ! { return stops.onStack('tableDataBlock'); }
    p:pipe
    ![+-] td:table_data_tag
    tagEndPos:("" { return endOffset(); })
    tds:tds {
        var da = td[0].dataAttribs;
        da.tsr[0] = da.tsr[0] - p.length; // include "|"
        if (p !== "|") {
            // Variation from default
            da.startTagSrc = p;
        }
        return td.concat(tds);
    }

implicit_table_data_tag
  = & sol // Implicit table data tag added only when content starts on a newline
    !( nl_comment_space* (pipe / [!+-]) )
    ! "}"
    tagEndPos:("" { return endOffset(); })
    b:nested_block+
    tds:tds {
        b = tu.flattenIfArray(b);
        var nlTok = b.shift();
        var td = tu.buildTableTokens("td", "|", '', [nlTok.dataAttribs.tsr[1], tagEndPos], endOffset(), b);
        td[0].dataAttribs.autoInsertedStart = true;
        td[0].dataAttribs.autoInsertedEnd = true;
        return [ nlTok ].concat(td, tds);
    }

table_data_tag
  = ! "}"
    arg:row_syntax_table_args?
    // use inline_breaks to break on tr etc
    tagEndPos:("" { return endOffset(); })
    td:nested_block_in_table*
    {
        return tu.buildTableTokens("td", "|", arg, [startOffset(), tagEndPos], endOffset(), td);
    }

table_heading_tags
  = "!"
    & { return stops.push('th', endOffset()); }
    th:table_heading_tag
    ths:( pp:("!!" / pipe_pipe) tht:table_heading_tag {
            var da = tht[0].dataAttribs;
            da.stx_v = 'row';
            da.tsr[0] = da.tsr[0] - pp.length; // include "!!" or "||"

            if (pp !== "!!" || (da.startTagSrc && da.startTagSrc !== pp)) {
                // Variation from default
                da.startTagSrc = pp + (da.startTagSrc ? da.startTagSrc.substring(1) : '');
            }
            return tht;
          }
    )* {
        stops.pop('th');
        th[0].dataAttribs.tsr[0]--; // include "!"
        return th.concat(ths);
    }
    / & { return stops.onStack('th') !== false ? stops.pop('th') : false; }

table_heading_tag
  = arg:row_syntax_table_args?
    tagEndPos:("" { return endOffset(); })
    c:( & {
      // This SyntaxStop is only true until we hit the end of the line.
      if (stops.onStack('th') !== false &&
              /\n/.test(input.substring(stops.onStack('th'), endOffset()))) {
          // There's been a newline. Remove the break and continue
          // tokenizing nested_block_in_tables.
          stops.pop('th');
      }
      return true;
    } d:nested_block_in_table { return d; } )* {
        return tu.buildTableTokens("th", "!", arg, [startOffset(), tagEndPos], endOffset(), c);
    }

table_end_tag
  = sc:(space / comment)* startPos:("" { return endOffset(); }) p:pipe b:"}" {
      var tblEnd = new EndTagTk('table', [], { tsr: [startPos, endOffset()] });
      if (p !== "|") {
          // p+"<brace-char>" is triggering some bug in pegJS
          // I cannot even use that expression in the comment!
          tblEnd.dataAttribs.endTagSrc = p + b;
      }
      return sc.concat([tblEnd]);
  }

/**
 * Table parameters separated from the content by a single pipe. Does *not*
 * match if followed by double pipe (row-based syntax).
 */
row_syntax_table_args
  = & { return stops.push('tableCellArg', true); }
    as:table_attributes s:space* p:pipe !pipe {
        stops.pop('tableCellArg');
        return [as, s, p];
    }
    / & { return stops.pop('tableCellArg'); }


/*******************************************************************
 * Text variants and other general rules
 *******************************************************************/

/* All chars that cannot start syntactic structures in the middle of a line
 * XXX: ] and other end delimiters should probably only be activated inside
 * structures to avoid unnecessarily leaving the text rule on plain
 * content.
 *
 * TODO: Much of this is should really be context-dependent (syntactic
 * flags). The wikilink_preprocessor_text rule is an example where
 * text_char is not quite right and had to be augmented. Try to minimize /
 * clarify this carefully!
 */

text_char = [^-'<~[{\n\r:;\]}|!=]

/* Legend
 * '    quotes (italic/bold)
 * <    start of xmlish_tag
 * ~    signatures/dates
 * [    start of links
 * {    start of parser functions, transclusion and template args
 * \n   all sort of block-level markup at start of line
 * \r   ditto
 * A-Za-z autolinks (http(s), nttp(s), mailto, ISBN, PMID, RFC)
 *
 * _    behavior switches (e.g., '__NOTOC__') (XXX: not URL related)
 * ! and | table cell delimiters, might be better to specialize those
 * =    headings - also specialize those!
 *
 * The following chars are also included for now, but only apply in some
 * contexts and should probably be enabled only in those:
 * :    separate definition in ; term : definition
 * ]    end of link
 * }    end of parser func/transclusion/template arg
 * -    start of lang_variant -{ ... }-
 * ;    separator in lang_variant
 */

urltext = ( $[^-'<~[{\n/A-Za-z_|!:;\]} &=]+
          / & [/A-Za-z] al:autolink { return al; }
          / & "&" he:htmlentity { return he; }
          // Convert trailing space into &nbsp;
          // XXX: This should be moved to a serializer
          // This is a hack to force a whitespace display before the colon
          / ' ' & ':' {
              var toks = Util.placeholder('\u00a0', {
                src: ' ',
                tsr: tsrOffsets('start'),
                isDisplayHack: true,
              }, { tsr: tsrOffsets('end'), isDisplayHack: true });
              var typeOf = toks[0].getAttribute('typeof');
              toks[0].setAttribute('typeof', 'mw:DisplaySpace ' + typeOf);
              return toks;
          }
          / & ('__') bs:behavior_switch { return bs; }
          // About 96% of text_char calls originate here.
          // pegjs 0.8 inlines this simple rule automatically.
          / text_char )+

raw_htmlentity = m:$("&" [#0-9a-zA-Z]+ ";") {
    return Util.decodeEntities(m);
}

htmlentity = cc:raw_htmlentity {
    // if this is an invalid entity, don't tag it with 'mw:Entity'
    if (cc.length > 2 /* decoded entity would be 1 or 2 UTF-16 characters */) {
        return cc;
    }
    return [
        new TagTk('span', [new KV('typeof', 'mw:Entity')], { src: text(), srcContent: cc, tsr: tsrOffsets('start') }),
        cc,
        new EndTagTk('span', [], { tsr: tsrOffsets('end') }),
    ];
}

spaces
  = $[ \t]+

space = [ \t]

optionalSpaceToken
  = s:$space* {
      if (s.length) {
          return [s];
      } else {
          return [];
      }
  }

/* This rule corresponds to \s in the PHP preg_* functions,
 * which is used frequently in the PHP parser.  The inclusion of
 * form feed (but not other whitespace, like vertical tab) is a quirk
 * of Perl, which PHP inherited via the PCRE (Perl-Compatible Regular
 * Expressions) library.
 */
space_or_newline
  = [ \t\n\r\x0c]

/* This rule corresponds to \b in the PHP preg_* functions,
 * after a word character.  That is, it's a zero-width lookahead that
 * the next character is not a word character.
 */
end_of_word
  = eof / ![A-Za-z0-9_]

// Unicode "separator, space" category.  It covers the \u0020 space as well
// as \u3000 IDEOGRAPHIC SPACE (see bug 19052).  In PHP this is \p{Zs}.
// Keep this up-to-date with the characters tagged ;Zs; in
// http://www.unicode.org/Public/UNIDATA/UnicodeData.txt
unispace = [ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]

// Non-newline whitespace, including non-breaking spaces.  Used for magic links.
space_or_nbsp
  = space // includes \t
  / unispace
  / he:htmlentity &{ return Array.isArray(he) && /^\u00A0$/.test(he[1]); }
    { return he; }

// Used within ISBN magic links
space_or_nbsp_or_dash
  = space_or_nbsp / "-"

// Extra newlines followed by at least another newline. Usually used to
// compress surplus newlines into a meta tag, so that they don't trigger
// paragraphs.
optionalNewlines
  = spc:$([\n\r\t ] &[\n\r])* {
        if (spc.length) {
            return [spc];
        } else {
            return [];
        }
    }

sol = (empty_line_with_comments / sol_prefix) (comment / (
        ( & { return stops.push("sol_il", true); }
          i:include_limits
          & { stops.pop("sol_il"); return true; }
        ) { return i; }
        / & { return stops.pop("sol_il"); }
      ))*

sol_prefix
  = newlineToken
  / & {
      // Use the sol flag only at the start of the input
      // NOTE: Explicitly check for 'false' and not a falsy value
      return endOffset() === 0 && options.sol !== false;
  } { return []; }

empty_line_with_comments
  = sp:sol_prefix p:("" { return endOffset(); }) c:(space* comment (space / comment)* newline)+ {
        return [
            sp,
            new SelfclosingTagTk("meta", [new KV('typeof', 'mw:EmptyLine')], {
                tokens: tu.flattenIfArray(c),
                tsr: [p, endOffset()],
            }),
        ];
    }

comment_space = comment / space

nl_comment_space = newline / comment_space

/**
 * noinclude / includeonly / onlyinclude rules. These are normally
 * handled by the generic_tag rule, except where generic tags are not
 * allowed- for example in directives, which are allowed in various attribute
 * names and -values.
 *
 * Example test case:
 * {|
 * |-<includeonly>
 * foo
 * </includeonly>
 * |Hello
 * |}
 */

include_limits =
  il:("<" c:"/"? name:$(n:$[oyinclude]i+ & {
    var incl = n.toLowerCase();
    return incl === "noinclude" || incl === "onlyinclude" ||
      incl === "includeonly";
  }) space_or_newline* ">" {
    var incl = name.toLowerCase();
    var dp = { tsr: tsrOffsets() };

    // Record variant since tag is not in normalized lower case
    if (name !== incl) {
      dp.srcTagName = name;
    }

    // End tag only
    if (c) {
      return new EndTagTk(name, [], dp);
    }

    var restOfInput = input.substring(endOffset());
    var tagContent = restOfInput.match(new RegExp("^([\\s\\S]*?)(?:</\\s*" + incl + "\\s*>)", "m"));

    // Start tag only
    if (!tagContent || !tagContent[1]) {
      return new TagTk(name, [], dp);
    }

    // Get the content
    var inclContent = tagContent[1];

    // Preserve SOL where necessary (for onlyinclude and noinclude)
    // Note that this only works because we encounter <*include*> tags in
    // the toplevel content and we rely on the php preprocessor to expand
    // templates, so we shouldn't ever be tokenizing inInclude.
    // Last line should be empty (except for comments)
    if (incl !== "includeonly" && stops.onStack("sol_il")) {
      var last = lastItem(inclContent.split('\n'));
      if (!/^(<!--([^-]|-(?!->))*-->)*$/.test(last)) {
        return false;
      }
    }

    // Tokenize include content in a new tokenizer
    var inclContentToks = (new PegTokenizer(env)).tokenizeSync(inclContent);
    inclContentToks = Util.stripEOFTkfromTokens(inclContentToks);

    // Shift tsr
    Util.shiftTokenTSR(inclContentToks, endOffset());

    // Skip past content
    peg$currPos += inclContent.length;

    return [new TagTk(name, [], dp)].concat(inclContentToks);
  }) & { return !!il; } { return il; }

// Start of file
sof = & { return endOffset() === 0 && !options.pipelineOffset; }

// End of file
eof = & { return endOffset() === input.length; }

newline = '\n' / '\r\n'

newlineToken = newline { return [new NlTk(tsrOffsets())]; }

eolf = newline / eof

comment_space_eolf = (space+ / comment)* (newline / eof)

// 'Preprocessor' directive- higher-level things that can occur in otherwise
// plain-text content.
directive
  = comment
  / nowiki
  / tplarg_or_template
  / & "&" e:htmlentity { return e; }
  / include_limits

wikilink_preprocessor_text
  = r:( t:$[^<[{\n\r\t|!\]}{ &\-]+
        // XXX gwicke: any more chars we need to allow here?
        / !inline_breaks wr:( directive / $( !"]]" ( text_char / [!<\-] ) ) )
        { return wr; }
    )+ {
      return tu.flattenStringlist(r);
  }

extlink_preprocessor_text
  // added special separator character class inline: separates url from
  // description / text
  = r:( $[^'<~[{\n\r|!\]}\t&="' \u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]+
  / !inline_breaks s:( directive / no_punctuation_char ) { return s; }
  /// urlencoded_char
  // !inline_breaks no_punctuation_char
  / $([.:,] !(space / eolf))
  / $(['] ![']) // single quotes are ok, double quotes are bad
  / [&%|{] )+ {
      return tu.flattenString(r);
  }

// Attribute values with preprocessor support

// n.b. / is a permissible char in the three rules below.
// We only break on />, enforced by the negated expression.
// Hence, it isn't included in the stop set.

// The stop set is space_or_newline and > which matches generic_att_value.
attribute_preprocessor_text
  = r:( $[^{}&<\-|/ \t\n\r\x0c>]+
  / !inline_breaks
    !'/>'
    s:( directive / [{}&<\-|/] ) { return s; }
  )+ {
    return tu.flattenString(r);
  }

// The stop set is '> which matches generic_att_value.
attribute_preprocessor_text_single
  = r:( $[^{}&<\-|/'>]+
  / !inline_breaks
    !'/>'
    s:( directive / [{}&<\-|/] ) { return s; }
  )* {
    return tu.flattenString(r);
  }

// The stop set is "> which matches generic_att_value.
attribute_preprocessor_text_double
  = r:( $[^{}&<\-|/">]+
  / !inline_breaks
    !'/>'
    s:( directive / [{}&<\-|/] ) { return s; }
  )* {
    return tu.flattenString(r);
  }

// Variants with the entire attribute on a single line

// n.b. ! is a permissible char in the three rules below.
// We only break on !! in th, enforced by the inline break.
// Hence, it isn't included in the stop set.
// [ is also permissible but we give a chance to break
// for the [[ special case in php's doTableStuff (See T2553).

// The stop set is space_or_newline and | which matches table_att_value.
table_attribute_preprocessor_text
  = r:( $[^{}&<\-!\[ \t\n\r\x0c|]+
  / !inline_breaks s:( directive / [{}&<\-!\[] ) { return s; }
  )+ {
    return tu.flattenString(r);
  }

// The stop set is '\r\n| which matches table_att_value.
table_attribute_preprocessor_text_single
  = r:( $[^{}&<\-!\['\r\n|]+
  / !inline_breaks s:( directive / [{}&<\-!\[] ) { return s; }
  )* {
    return tu.flattenString(r);
  }

// The stop set is "\r\n| which matches table_att_value.
table_attribute_preprocessor_text_double
  = r:( $[^{}&<\-!\["\r\n|]+
  / !inline_breaks s:( directive / [{}&<\-!\[] ) { return s; }
  )* {
    return tu.flattenString(r);
  }

// Special-case support for those pipe templates
pipe = "|" / "{{!}}"

// SSS FIXME: what about |{{!}} and {{!}}|
pipe_pipe = "||" / "{{!}}{{!}}"
