#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Editor webu – Tábor šlapanických divadelníků
=============================================

Otevře web v prohlížeči tak, že jde upravovat kliknutím: texty jako
v PowerPointu, fotky výměnou souboru. Změny ukládá přímo do HTML souborů
a tlačítkem „Zveřejnit“ je pošle na GitHub (→ www.taborslapanice.cz).

Spouští se dvojklikem na „Upravit web.command“ v kořeni webu.

Jak to funguje
--------------
* Server běží jen na 127.0.0.1, zvenku není dostupný. Každý zápis navíc
  vyžaduje tajný token, který dostane jen stránka vygenerovaná editorem.
* Stránka se v editoru zobrazí bez vlastních skriptů webu – co je vidět,
  odpovídá přesně zdrojovému souboru, nic do něj „nedopisuje“ JavaScript.
* Při ukládání se nikdy nepřepisuje celá stránka. Nahradí se jen vnitřek
  konkrétních prvků, přesně podle jejich pozice ve zdrojovém souboru –
  zbytek HTML zůstane bajt po bajtu stejný.
* Před zápisem se kontroluje, že se soubor mezitím nezměnil a že úprava
  nepoškodí strukturu stránky.

Používá jen standardní knihovnu Pythonu 3.
"""

import argparse
import hashlib
import html
import json
import mimetypes
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import webbrowser
from datetime import date, datetime
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EDITOR_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(EDITOR_DIR, 'static')
DEFAULT_ROOT = os.path.dirname(EDITOR_DIR)

SITE_URL = 'https://www.taborslapanice.cz/'
TITLE_SUFFIX = ' :: tábor šlapanických divadelníků'

# ---------------------------------------------------------------------------
#  Druhy HTML prvků
# ---------------------------------------------------------------------------

VOID = frozenset('area base br col embed hr img input link meta param source track wbr'.split())

# Řádkové prvky – smí být uvnitř upravovaného textu.
INLINE = frozenset(
    'a abbr b bdi bdo big br cite code data del dfn em font i ins kbd mark nobr '
    'q s samp small span strike strong sub sup time tt u var wbr'.split())

# Tyto prvky nikdy nejsou samy o sobě upravovaným textem.
NEVER_LEAF = frozenset(
    'html head body script style title template noscript textarea select option '
    'optgroup iframe svg math object embed video audio canvas picture table thead '
    'tbody tfoot tr ul ol dl form button input label'.split())

# Do těchto míst editor vůbec nesahá.
NO_EDIT_ZONE = frozenset(
    'head script style title template noscript textarea select svg math iframe object'.split())

# Obsah těchto prvků není text pro čtenáře.
RAWTEXT = frozenset('script style template noscript textarea title'.split())

# Kontejner s těmito prvky se nesmí přepisovat celý.
UNSAFE = frozenset(
    'script style template noscript iframe object embed form input select textarea '
    'button video audio canvas svg math'.split())

# Prvky, u kterých jde přidat / zkopírovat / smazat řádek.
STRUCT_LEAF = frozenset('p li h1 h2 h3 h4 h5 h6 blockquote dt dd'.split())
BOX_TAGS = frozenset('div section article main aside ul ol li dl td th blockquote'.split())

# Co se nesmí objevit v textu, který posílá prohlížeč k uložení.
FORBIDDEN_IN_FRAGMENT = frozenset(
    'script style iframe object embed form input textarea select button template '
    'link meta base frame frameset html head body title noscript svg math video '
    'audio canvas'.split())

SKIP_DIRS = frozenset(['_editor', '_sablony', 'vedouci', 'home', 'obrazky', 'node_modules'])

# Prvky, které na živém webu nahrazuje cizí skript (např. tlačítko Twitteru).
WIDGET_CLASSES = frozenset(['twitter-share-button', 'fb-share-button'])

MAIN_ORDER = [
    'index.html', 'o-nas/index.html', 'aktuality/index.html', 'index/index.html',
    'ke-stazeni/index.html', 'fotogalerie/index.html', 'kontakt/index.html',
    'zasady-ochrany-osobnich-udaju/index.html',
]


# ---------------------------------------------------------------------------
#  Parser, který si pamatuje přesné pozice prvků ve zdrojovém souboru
# ---------------------------------------------------------------------------

class Node:
    __slots__ = ('tag', 'attrs', 'start', 'start_end', 'end', 'end_end', 'parent',
                 'content', 'children', 'closed', 'reliable', 'starttag',
                 'clean', 'inline_only', 'has_text', 'unsafe', 'ids_inside', 'is_leaf')

    def __init__(self, tag, attrs, start, start_end, parent, starttag):
        self.tag = tag
        self.attrs = {}
        for k, v in attrs:
            self.attrs.setdefault(k, v)
        self.start = start            # pozice '<' počáteční značky
        self.start_end = start_end    # pozice hned za '>' počáteční značky
        self.end = None               # pozice '</' koncové značky
        self.end_end = None           # pozice hned za '>' koncové značky
        self.parent = parent
        self.content = []             # text (str) a podřízené prvky (Node) v pořadí
        self.children = []
        self.closed = False           # má vlastní, správně spárovanou koncovou značku
        self.reliable = True          # pozice v souboru sedí
        self.starttag = starttag
        self.is_leaf = False

    def cls(self):
        return (self.attrs.get('class') or '').split()


class Tree(HTMLParser):
    def __init__(self, src):
        super().__init__(convert_charrefs=True)
        self.src = src
        self._lines = [0] + [m.end() for m in re.finditer('\n', src)]
        self.root = Node('#root', (), 0, 0, None, '')
        self.root.closed = True
        self.stack = [self.root]
        self.nodes = []
        self.problems = 0
        self.feed(src)
        self.close()
        for n in self.stack[1:]:          # neuzavřené až do konce souboru
            n.closed = False
            n.end = n.end_end = len(src)
            self.problems += 1
        del self.stack[1:]

    def _pos(self):
        line, col = self.getpos()
        return self._lines[line - 1] + col

    def _add(self, tag, attrs, self_closing):
        pos = self._pos()
        text = self.get_starttag_text() or ''
        node = Node(tag, attrs, pos, pos + len(text), self.stack[-1], text)
        if not self.src.startswith(text, pos) or not text:
            node.reliable = False
        parent = self.stack[-1]
        parent.content.append(node)
        parent.children.append(node)
        self.nodes.append(node)
        if self_closing or tag in VOID:
            node.closed = True
            node.end = node.end_end = node.start_end
        else:
            self.stack.append(node)

    def handle_starttag(self, tag, attrs):
        self._add(tag, attrs, False)

    def handle_startendtag(self, tag, attrs):
        self._add(tag, attrs, True)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        pos = self._pos()
        gt = self.src.find('>', pos)
        end = gt + 1 if gt >= 0 else len(self.src)
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                for n in self.stack[i + 1:]:      # uzavřené jen implicitně
                    n.closed = False
                    n.end = n.end_end = pos
                    self.problems += 1
                node = self.stack[i]
                node.closed = True
                node.end, node.end_end = pos, end
                if not self.src.startswith('</', pos):
                    node.reliable = False
                del self.stack[i:]
                return
        self.problems += 1                        # osiřelá koncová značka

    def handle_data(self, data):
        self.stack[-1].content.append(data)


def _compute(n):
    """Spočítá pro každý prvek vlastnosti potřebné k rozhodnutí, co jde upravit."""
    clean = n.closed and n.reliable
    inline_only = True
    has_text = False
    unsafe = False
    ids = set()
    for it in n.content:
        if isinstance(it, str):
            if n.tag not in RAWTEXT and it.strip():
                has_text = True
            continue
        _compute(it)
        clean = clean and it.clean
        if it.tag not in INLINE or not it.inline_only:
            inline_only = False
        if it.tag not in RAWTEXT and it.has_text:
            has_text = True
        if (it.unsafe or it.tag in UNSAFE or 'hidden' in it.attrs
                or any(k.startswith('on') for k in it.attrs)):
            unsafe = True
        ids |= it.ids_inside
        if it.attrs.get('id'):
            ids.add(it.attrs['id'])
    n.clean, n.inline_only, n.has_text, n.unsafe, n.ids_inside = clean, inline_only, has_text, unsafe, ids


def norm_text(s):
    s = s.replace('​', '').replace('﻿', '')
    return re.sub(r'\s+', ' ', s).strip()


def node_text(n):
    out = []

    def rec(x):
        for it in x.content:
            if isinstance(it, str):
                out.append(it)
            elif it.tag not in RAWTEXT:
                rec(it)
    rec(n)
    return norm_text(''.join(out))


class Analysis:
    """Rozbor stránky: co jde upravit a kde přesně to v souboru je."""

    def __init__(self, src):
        t = Tree(src)
        self.src = src
        self.tree = t
        self.problems = t.problems
        self.leaves = []       # [(node, zámek)] – upravitelné texty
        self.boxes = []        # kontejnery, do kterých jde přidávat řádky
        self.imgs = []         # vyměnitelné obrázky
        self.reveal = []       # skryté prvky, které editor ukáže
        self._reveal_set = set()
        self.scripts = [n for n in t.nodes if n.tag == 'script']
        self.head = next((n for n in t.nodes if n.tag == 'head'), None)
        self.body = next((n for n in t.nodes if n.tag == 'body'), None)

        # Prvky, do kterých zapisuje JavaScript webu (např. odpočet).
        self.dyn_ids = set()
        for s in self.scripts:
            code = ''.join(x for x in s.content if isinstance(x, str))
            self.dyn_ids.update(re.findall(r'getElementById\(\s*[\'"]([^\'"]+)[\'"]', code))
            for sel in re.findall(r'querySelector(?:All)?\(\s*[\'"]([^\'"]+)[\'"]', code):
                self.dyn_ids.update(re.findall(r'#([\w-]+)', sel))

        _compute(t.root)
        self._walk(t.root, False, False)

    def _walk(self, n, shared, hidden):
        for c in n.children:
            tag = c.tag
            if tag in NO_EDIT_ZONE:
                continue
            sh = shared or tag in ('header', 'footer')
            hd = hidden or 'hidden' in c.attrs
            if tag == 'img':
                if not sh and not hd and c.clean and c.attrs.get('src'):
                    self.imgs.append(c)
                continue
            if (tag not in NEVER_LEAF and c.clean and c.inline_only and c.has_text
                    and not c.unsafe and not any(k.startswith('on') for k in c.attrs)):
                c.is_leaf = True
                if sh:
                    lock = 'shared'
                elif (c.attrs.get('id') in self.dyn_ids
                      or (c.parent is not None and c.parent.attrs.get('id') in self.dyn_ids)
                      or (c.ids_inside & self.dyn_ids)
                      or WIDGET_CLASSES.intersection(c.cls())):
                    lock = 'dynamic'
                else:
                    lock = None
                self.leaves.append((c, lock))
                if hd and not sh:
                    p = c
                    while p is not None and p.tag != '#root':
                        if 'hidden' in p.attrs and p not in self._reveal_set:
                            self._reveal_set.add(p)
                            self.reveal.append(p)
                        p = p.parent
                continue
            self._walk(c, sh, hd)
            if (not sh and not hd and tag in BOX_TAGS and c.clean and not c.unsafe
                    and not any(k.startswith('on') for k in c.attrs)
                    and any(x.is_leaf and x.tag in STRUCT_LEAF for x in c.children)):
                self.boxes.append(c)


# ---------------------------------------------------------------------------
#  Úpravy počátečních značek (atributy) bez přeformátování zbytku
# ---------------------------------------------------------------------------

_TAGNAME_RE = re.compile(r'<[a-zA-Z][^\s/>]*')
_ATTR_RE = re.compile(r'''(\s*)([^\s/>"'=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"'=<`]+))?''')


def _attr_spans(t):
    m = _TAGNAME_RE.match(t)
    if not m:
        return []
    pos, spans = m.end(), []
    while True:
        m = _ATTR_RE.match(t, pos)
        if not m or m.end() == pos:
            break
        spans.append((m.group(2).lower(), m.start(), m.end(), m.group(1)))
        pos = m.end()
    return spans


def tag_add(t, extra):
    if t.endswith('/>'):
        return t[:-2].rstrip() + extra + ' />'
    return t[:-1] + extra + '>'


def tag_remove(t, pred):
    for name, s, e, _ in reversed(_attr_spans(t)):
        if pred(name):
            t = t[:s] + t[e:]
    return t


def tag_set(t, name, value):
    piece = '%s="%s"' % (name, html.escape(value, quote=True))
    spans = [sp for sp in _attr_spans(t) if sp[0] == name]
    if not spans:
        return tag_add(t, ' ' + piece)
    for _, s, e, _ in reversed(spans[1:]):
        t = t[:s] + t[e:]
    _, s, e, ws = spans[0]
    return t[:s] + (ws or ' ') + piece + t[e:]


def apply_edits(src, edits):
    """edits = [(začátek, konec, nový text)] – nesmí se překrývat."""
    edits = sorted(edits, key=lambda x: (x[0], x[1]))
    for a, b in zip(edits, edits[1:]):
        if a[1] > b[0]:
            raise ValueError('Úpravy se navzájem překrývají.')
    out, pos = [], 0
    for s, e, text in edits:
        out.append(src[pos:s])
        out.append(text)
        pos = e
    out.append(src[pos:])
    return ''.join(out)


# ---------------------------------------------------------------------------
#  Kontrola HTML, které posílá prohlížeč k uložení
# ---------------------------------------------------------------------------

class _FragmentCheck(HTMLParser):
    def __init__(self, inline_only):
        super().__init__(convert_charrefs=True)
        self.inline_only = inline_only
        self.stack = []
        self.error = None

    def _bad(self, msg):
        if not self.error:
            self.error = msg

    def _check(self, tag, attrs):
        if tag in FORBIDDEN_IN_FRAGMENT:
            self._bad('nepovolený prvek <%s>' % tag)
        if self.inline_only and tag not in INLINE:
            self._bad('blokový prvek <%s> uvnitř textu' % tag)
        for k, v in attrs:
            if k.startswith('on'):
                self._bad('nepovolený atribut %s' % k)
            if k in ('href', 'src', 'srcset', 'action') and v and re.match(r'\s*(javascript|vbscript|data):', v, re.I):
                self._bad('nepovolený odkaz')

    def handle_starttag(self, tag, attrs):
        self._check(tag, attrs)
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self._check(tag, attrs)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack or self.stack[-1] != tag:
            self._bad('nesouhlasí uzavření </%s>' % tag)
            return
        self.stack.pop()


def check_fragment(s, inline_only):
    p = _FragmentCheck(inline_only)
    p.feed(s)
    p.close()
    if p.stack and not p.error:
        p.error = 'neuzavřený prvek <%s>' % p.stack[-1]
    return p.error


def safe_url(v):
    return bool(v) and not re.match(r'\s*(javascript|vbscript|data):', v, re.I)


# ---------------------------------------------------------------------------
#  Soubory webu
# ---------------------------------------------------------------------------

class Site:
    def __init__(self, root):
        self.root = os.path.realpath(root)
        self.lock = threading.Lock()

    def abspath(self, rel):
        full = os.path.realpath(os.path.join(self.root, rel))
        if full != self.root and not full.startswith(self.root + os.sep):
            return None
        parts = os.path.relpath(full, self.root).split(os.sep)
        if any(p.startswith('.') and p != '.' for p in parts):
            return None
        return full

    def read(self, rel):
        with open(os.path.join(self.root, rel), 'rb') as f:
            raw = f.read()
        bom = raw.startswith(b'\xef\xbb\xbf')
        src = raw[3:].decode('utf-8') if bom else raw.decode('utf-8')
        return src, bom, hashlib.sha1(raw).hexdigest()

    def write(self, rel, src, bom):
        full = os.path.join(self.root, rel)
        data = (b'\xef\xbb\xbf' if bom else b'') + src.encode('utf-8')
        tmp = full + '.ed-tmp'
        with open(tmp, 'wb') as f:
            f.write(data)
        try:
            os.chmod(tmp, os.stat(full).st_mode & 0o777)
        except OSError:
            pass
        os.replace(tmp, full)
        return hashlib.sha1(data).hexdigest()

    def page_paths(self):
        found = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            rel = os.path.relpath(dirpath, self.root)
            dirnames[:] = sorted(d for d in dirnames
                                 if not d.startswith(('.', '_')) and '.' not in d and d not in SKIP_DIRS)
            if 'index.html' in filenames:
                found.append('index.html' if rel == '.' else rel.replace(os.sep, '/') + '/index.html')
        return found

    def pages(self):
        out = []
        for p in self.page_paths():
            try:
                src, _, _ = self.read(p)
            except (OSError, UnicodeDecodeError):
                continue
            m = re.search(r'<title>(.*?)</title>', src, re.S | re.I)
            title = norm_text(html.unescape(m.group(1))) if m else p
            if title.endswith(TITLE_SUFFIX.strip()) and TITLE_SUFFIX in title:
                title = title[:title.rindex(TITLE_SUFFIX)]
            if p == 'index.html':
                title = 'Úvod'
            m = re.search(r'og:article:published_time" content="([^"]+)"', src)
            out.append({
                'path': p,
                'url': '/' if p == 'index.html' else '/' + p[:-len('index.html')],
                'title': title,
                'group': 'Články (Aktuality)' if p.startswith('l/') else 'Stránky',
                'published': m.group(1) if m else '',
            })

        def key(x):
            if x['path'] in MAIN_ORDER:
                return (0, MAIN_ORDER.index(x['path']), '')
            if not x['path'].startswith('l/'):
                return (1, 0, x['title'])
            return (2, 0, ''.join(chr(0x10FFFF - ord(c)) for c in x['published']) or x['title'])
        return sorted(out, key=key)

    # --- git -------------------------------------------------------------

    def git(self, *args, timeout=60):
        env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
        try:
            return subprocess.run(['git', *args], cwd=self.root, capture_output=True,
                                  text=True, timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            return subprocess.CompletedProcess(args, 124, '', 'Vypršel čas (git %s).' % args[0])
        except FileNotFoundError:
            return subprocess.CompletedProcess(args, 127, '', 'Git není nainstalovaný.')

    def pending(self):
        r = self.git('status', '--porcelain', '-z', '--untracked-files=all', '--', '*.html', 'obrazky')
        entries, parts, i = [], r.stdout.split('\0'), 0
        while i < len(parts):
            e = parts[i]
            i += 1
            if len(e) < 4:
                continue
            code, path = e[:2], e[3:]
            if code[0] in 'RC':
                i += 1
            entries.append((code, path))
        titles = {p['path']: p['title'] for p in self.pages()}
        items, sources = [], None
        for code, path in entries:
            if path.endswith('.html'):
                if path in titles:
                    items.append({'path': path, 'label': titles[path], 'kind': 'page', 'code': code})
            elif path.startswith('obrazky/'):
                if sources is None:
                    sources = ''
                    for p in titles:
                        try:
                            sources += self.read(p)[0]
                        except (OSError, UnicodeDecodeError):
                            pass
                name = os.path.basename(path)
                if name in sources or urllib.parse.quote(name) in sources:
                    items.append({'path': path, 'label': 'Nová fotka ' + name, 'kind': 'image', 'code': code})
        ahead = 0
        r = self.git('rev-list', '--count', '@{u}..HEAD')
        if r.returncode != 0:
            r = self.git('rev-list', '--count', 'origin/main..HEAD')
        if r.returncode == 0 and r.stdout.strip().isdigit():
            ahead = int(r.stdout.strip())
        return {'items': items, 'ahead': ahead}


# ---------------------------------------------------------------------------
#  Stránka pro editor
# ---------------------------------------------------------------------------

def render_editor_page(site, rel, token):
    src, bom, digest = site.read(rel)
    an = Analysis(src)
    mods = {}

    def cur(n):
        return mods.get(n, n.starttag)

    for i, (n, lock) in enumerate(an.leaves):
        mods[n] = tag_add(cur(n), ' data-ed="%d"' % i + (' data-ed-lock="%s"' % lock if lock else ''))
    for i, n in enumerate(an.boxes):
        mods[n] = tag_add(cur(n), ' data-ed-box="%d"' % i)
    for i, n in enumerate(an.imgs):
        mods[n] = tag_add(cur(n), ' data-ed-img="%d"' % i)
    for n in an.reveal:
        mods[n] = tag_add(tag_remove(cur(n), lambda a: a == 'hidden'), ' data-ed-reveal=""')
    for n in an.scripts:                       # skripty webu v editoru neběží
        mods[n] = tag_set(cur(n), 'type', 'text/x-ed-off')
    for n in an.tree.nodes:                    # ani obsluha událostí (onclick…)
        if any(k.startswith('on') for k in n.attrs):
            mods[n] = tag_remove(cur(n), lambda a: a.startswith('on'))

    titles = {p['path']: p['title'] for p in site.pages()}
    meta = {
        'path': rel,
        'title': titles.get(rel, rel),
        'hash': digest,
        'token': token,
        'depth': rel.count('/'),
        'texts': [node_text(n) for n, _ in an.leaves],
        'boxTexts': [node_text(n) for n in an.boxes],
        'site': SITE_URL,
    }
    meta_json = json.dumps(meta, ensure_ascii=False).replace('</', '<\\/')
    head_inj = '<link rel="stylesheet" href="/__editor__/editor.css">'
    body_inj = ('<script id="ed-meta" type="application/json">%s</script>'
                '<script src="/__editor__/editor.js"></script>' % meta_json)

    edits = [(n.start, n.start_end, t) for n, t in mods.items()]
    hp = an.head.end if an.head is not None and an.head.closed else 0
    bp = an.body.end if an.body is not None and an.body.closed else len(src)
    edits.append((hp, hp, head_inj))
    edits.append((bp, bp, body_inj))
    return apply_edits(src, edits)


# ---------------------------------------------------------------------------
#  Uložení změn
# ---------------------------------------------------------------------------

class SaveError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def save_page(site, data):
    rel = data.get('path') or ''
    if rel not in site.page_paths():
        raise SaveError('Tahle stránka se v editoru upravovat nedá.')
    src, bom, digest = site.read(rel)
    if digest != data.get('hash'):
        raise SaveError('Stránka se mezitím změnila (třeba v jiném okně nebo ji upravil někdo jiný). '
                        'Načti ji prosím znovu – neuložený text si předtím zkopíruj.', 409)
    an = Analysis(src)
    edits = []

    def leaf(i):
        if not isinstance(i, int) or not 0 <= i < len(an.leaves):
            raise SaveError('Neznámý prvek stránky.')
        n, lock = an.leaves[i]
        if lock:
            raise SaveError('Tenhle text se v editoru upravovat nedá.')
        return n

    for item in data.get('leaves') or []:
        n = leaf(item.get('id'))
        frag = item.get('html') or ''
        err = check_fragment(frag, inline_only=True)
        if err:
            raise SaveError('Text nejde uložit (%s).' % err)
        edits.append((n.start_end, n.end, frag))

    for item in data.get('leafAttrs') or []:
        n = leaf(item.get('id'))
        href = (item.get('href') or '').strip()
        if n.tag != 'a' or not safe_url(href):
            raise SaveError('Neplatný odkaz.')
        edits.append((n.start, n.start_end, tag_set(n.starttag, 'href', href)))

    for item in data.get('boxes') or []:
        i = item.get('id')
        if not isinstance(i, int) or not 0 <= i < len(an.boxes):
            raise SaveError('Neznámá část stránky.')
        n = an.boxes[i]
        frag = item.get('html') or ''
        err = check_fragment(frag, inline_only=False)
        if err:
            raise SaveError('Úpravu nejde uložit (%s).' % err)
        edits.append((n.start_end, n.end, frag))

    page_dir = os.path.dirname(os.path.join(site.root, rel))
    obrazky = os.path.join(site.root, 'obrazky') + os.sep
    for item in data.get('images') or []:
        i = item.get('id')
        if not isinstance(i, int) or not 0 <= i < len(an.imgs):
            raise SaveError('Neznámý obrázek.')
        n = an.imgs[i]
        src_attr = item.get('src') or ''
        target = os.path.realpath(os.path.join(page_dir, urllib.parse.unquote(src_attr)))
        if not target.startswith(obrazky) or not os.path.isfile(target):
            raise SaveError('Nahraná fotka se nenašla.')
        w, h = item.get('width'), item.get('height')
        t = tag_set(n.starttag, 'src', src_attr)
        t = tag_remove(t, lambda a: a in ('srcset', 'sizes'))
        if isinstance(w, int) and isinstance(h, int) and 0 < w < 20000 and 0 < h < 20000:
            t = tag_set(tag_set(t, 'width', str(w)), 'height', str(h))
        edits.append((n.start, n.start_end, t))
        if n.parent is not None and n.parent.tag == 'picture':
            for s in n.parent.children:
                if s.tag == 'source':
                    edits.append((s.start, s.start_end, ''))

    if not edits:
        return digest
    try:
        new_src = apply_edits(src, edits)
    except ValueError as e:
        raise SaveError(str(e))
    if Analysis(new_src).problems > an.problems:
        raise SaveError('Úprava by poškodila strukturu stránky, proto se neuložila.')
    return site.write(rel, new_src, bom)


# ---------------------------------------------------------------------------
#  Nahrání fotky
# ---------------------------------------------------------------------------

IMAGE_TYPES = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'}


def slugify(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii').lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:40]


def save_upload(site, data, ctype, name):
    ext = IMAGE_TYPES.get(ctype)
    if not ext:
        raise SaveError('Tohle není podporovaný obrázek (JPG, PNG, WebP nebo GIF).')
    magic_ok = {
        'jpg': data[:3] == b'\xff\xd8\xff',
        'png': data[:8] == b'\x89PNG\r\n\x1a\n',
        'webp': data[:4] == b'RIFF' and data[8:12] == b'WEBP',
        'gif': data[:4] == b'GIF8',
    }[ext]
    if not magic_ok:
        raise SaveError('Soubor nevypadá jako obrázek.')
    folder = os.path.join(site.root, 'obrazky')
    os.makedirs(folder, exist_ok=True)
    base = '%s-%s' % (date.today().isoformat(), slugify(os.path.splitext(name)[0]) or 'foto')
    fname, n = '%s.%s' % (base, ext), 2
    while os.path.exists(os.path.join(folder, fname)):
        fname, n = '%s-%d.%s' % (base, n, ext), n + 1
    with open(os.path.join(folder, fname), 'wb') as f:
        f.write(data)
    return 'obrazky/' + fname


# ---------------------------------------------------------------------------
#  Zveřejnění (git commit + push) a vrácení změn
# ---------------------------------------------------------------------------

def _git_detail(r):
    return ((r.stderr or '') + '\n' + (r.stdout or '')).strip()[-1500:]


def publish(site, paths):
    pend = site.pending()
    allowed = {i['path']: i for i in pend['items']}
    paths = [p for p in paths if p in allowed]
    if not paths and not pend['ahead']:
        raise SaveError('Není co zveřejnit – všechno už je na webu.')
    branch = site.git('rev-parse', '--abbrev-ref', 'HEAD').stdout.strip()
    if branch != 'main':
        raise SaveError('Web je přepnutý na větev „%s“, zveřejňuje se jen z „main“.' % branch)
    commit = None
    if paths:
        r = site.git('add', '--', *paths)
        if r.returncode:
            raise SaveError('Změny se nepodařilo připravit k odeslání.\n\n' + _git_detail(r))
        labels = [allowed[p]['label'] for p in paths if allowed[p]['kind'] == 'page']
        photos = sum(1 for p in paths if allowed[p]['kind'] == 'image')
        subject = 'Úprava webu: ' + (', '.join(labels) if labels else 'nové fotky')
        if len(subject) > 72:
            subject = subject[:69].rstrip(' ,') + '…'
        body = 'Upraveno v editoru webu.\n\n' + '\n'.join('- ' + p for p in paths)
        if photos and labels:
            body += '\n\nNových fotek: %d' % photos
        r = site.git('commit', '-m', subject, '-m', body, '--', *paths)
        if r.returncode:
            raise SaveError('Změny se nepodařilo zapsat do historie.\n\n' + _git_detail(r))
        commit = site.git('rev-parse', '--short', 'HEAD').stdout.strip()
    r = site.git('pull', '--rebase', '--autostash', 'origin', 'main', timeout=120)
    if r.returncode:
        site.git('rebase', '--abort')
        raise SaveError('Na GitHubu jsou mezitím jiné změny, které se nedají automaticky spojit. '
                        'Tvoje úpravy jsou v bezpečí na tomhle počítači – ozvi se prosím, '
                        'pomůžu je poslat.\n\n' + _git_detail(r))
    r = site.git('push', 'origin', 'main', timeout=120)
    if r.returncode:
        raise SaveError('Odeslání na GitHub se nepovedlo (zkontroluj internet). Úpravy zůstaly '
                        'uložené tady a zkusí se odeslat při příštím Zveřejnit.\n\n' + _git_detail(r))
    log('Zveřejněno: %s' % (', '.join(paths) or 'čekající změny'))
    return commit


def discard(site, paths):
    allowed = {i['path']: i for i in site.pending()['items']}
    done = []
    for p in paths:
        i = allowed.get(p)
        if not i:
            continue
        if i['code'] == '??':
            if i['kind'] == 'image':
                full = site.abspath(p)
                if full and os.path.isfile(full):
                    os.remove(full)
                    done.append(p)
        else:
            if site.git('checkout', 'HEAD', '--', p).returncode == 0:
                done.append(p)
    log('Vráceno do zveřejněné podoby: %s' % ', '.join(done))
    return done


# ---------------------------------------------------------------------------
#  HTTP server
# ---------------------------------------------------------------------------

def log(msg):
    print('  %s  %s' % (datetime.now().strftime('%H:%M:%S'), msg), flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = 'TSD-Editor/1'

    def log_message(self, fmt, *args):     # bez výpisu každého požadavku
        pass

    # --- pomocné -------------------------------------------------------------

    @property
    def site(self):
        return self.server.site

    def _send(self, code, body, ctype, headers=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        try:
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False), 'application/json; charset=utf-8')

    def _host_ok(self):
        host = (self.headers.get('Host') or '').lower()
        return host in ('127.0.0.1:%d' % self.server.port, 'localhost:%d' % self.server.port)

    def _token_ok(self):
        return secrets.compare_digest(self.headers.get('X-Editor-Token') or '', self.server.token)

    def _body(self, limit):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > limit:
            raise SaveError('Příliš velký nebo prázdný požadavek.')
        return self.rfile.read(n)

    # --- GET -----------------------------------------------------------------

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, 'Forbidden', 'text/plain')
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        if path.startswith('/__editor__/'):
            sub = path[len('/__editor__/'):]
            if sub == 'api/ping':
                return self._json(200, {'ok': True, 'app': 'tsd-editor', 'root': self.site.root})
            if sub.startswith('api/'):
                if not self._token_ok():
                    return self._json(403, {'ok': False, 'error': 'Neplatný přístup.'})
                if sub == 'api/pages':
                    return self._json(200, {'ok': True, 'pages': self.site.pages()})
                if sub == 'api/pending':
                    return self._json(200, dict(ok=True, **self.site.pending()))
                return self._json(404, {'ok': False, 'error': 'Neznámá akce.'})
            if sub in ('editor.js', 'editor.css'):
                with open(os.path.join(STATIC_DIR, sub), 'rb') as f:
                    data = f.read()
                ctype = 'text/javascript' if sub.endswith('.js') else 'text/css'
                return self._send(200, data, ctype + '; charset=utf-8')
            return self._send(404, 'Not found', 'text/plain')
        return self._serve_site(path, url.query)

    def _serve_site(self, path, query):
        full = self.site.abspath(path.lstrip('/'))
        if full is None:
            return self._send(404, 'Not found', 'text/plain')
        if os.path.isdir(full):
            if not path.endswith('/'):
                loc = urllib.parse.quote(path + '/') + ('?' + query if query else '')
                return self._send(301, '', 'text/plain', {'Location': loc})
            full = os.path.join(full, 'index.html')
        if not os.path.isfile(full):
            return self._send(404, '<h1>Stránka nenalezena</h1><p><a href="/">Zpět na úvod</a></p>',
                              'text/html; charset=utf-8')
        rel = os.path.relpath(full, self.site.root).replace(os.sep, '/')
        if rel.endswith('.html') and 'nahled' not in query and rel in self.site.page_paths():
            try:
                body = render_editor_page(self.site, rel, self.server.token)
            except Exception as e:   # stránku aspoň ukážeme bez editoru
                log('Stránku %s se nepodařilo připravit k úpravám: %s' % (rel, e))
                with open(full, 'rb') as f:
                    body = f.read()
            return self._send(200, body, 'text/html; charset=utf-8')
        ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'text/javascript'):
            ctype += '; charset=utf-8'
        with open(full, 'rb') as f:
            data = f.read()
        return self._send(200, data, ctype)

    # --- POST ----------------------------------------------------------------

    def do_POST(self):
        if not self._host_ok() or not self._token_ok():
            return self._json(403, {'ok': False, 'error': 'Neplatný přístup.'})
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == '/__editor__/api/save':
                data = json.loads(self._body(10 * 1024 * 1024))
                with self.site.lock:
                    digest = save_page(self.site, data)
                log('Uloženo: %s' % data.get('path'))
                return self._json(200, {'ok': True, 'hash': digest})

            if path == '/__editor__/api/upload':
                raw = self._body(25 * 1024 * 1024)
                ctype = (self.headers.get('Content-Type') or '').split(';')[0].strip().lower()
                name = urllib.parse.unquote(self.headers.get('X-File-Name') or 'foto')
                with self.site.lock:
                    rel = save_upload(self.site, raw, ctype, name)
                log('Nahrána fotka: %s (%d kB)' % (rel, len(raw) // 1024))
                return self._json(200, {'ok': True, 'path': rel})

            if path == '/__editor__/api/publish':
                data = json.loads(self._body(1024 * 1024))
                with self.site.lock:
                    commit = publish(self.site, data.get('paths') or [])
                return self._json(200, {'ok': True, 'commit': commit})

            if path == '/__editor__/api/discard':
                data = json.loads(self._body(1024 * 1024))
                with self.site.lock:
                    done = discard(self.site, data.get('paths') or [])
                return self._json(200, {'ok': True, 'done': done})

            if path == '/__editor__/api/quit':
                self._json(200, {'ok': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            return self._json(404, {'ok': False, 'error': 'Neznámá akce.'})
        except SaveError as e:
            msg = str(e)
            summary, _, detail = msg.partition('\n\n')
            if e.code != 409:
                log('Chyba: %s' % summary)
            return self._json(e.code, {'ok': False, 'error': summary, 'detail': detail})
        except (ValueError, KeyError, TypeError) as e:
            return self._json(400, {'ok': False, 'error': 'Neplatný požadavek (%s).' % e})
        except Exception as e:
            log('Neočekávaná chyba: %r' % e)
            return self._json(500, {'ok': False, 'error': 'Neočekávaná chyba editoru: %s' % e})


class EditorServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def ping(port, timeout=0.6):
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/__editor__/api/ping' % port, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description='Editor webu Tábora šlapanických divadelníků')
    ap.add_argument('--root', default=DEFAULT_ROOT, help='složka s webem')
    ap.add_argument('--port', type=int, default=8790)
    ap.add_argument('--no-browser', action='store_true', help='neotevírat prohlížeč')
    ap.add_argument('--no-pull', action='store_true', help='nestahovat novou verzi z GitHubu')
    args = ap.parse_args()
    try:                                   # výpisy do okna Terminálu hned, ne až později
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    site = Site(args.root)
    if not os.path.isfile(os.path.join(site.root, 'index.html')):
        print('Ve složce %s není web (chybí index.html).' % site.root)
        return 1

    print()
    print('  ==============================================')
    print('   Editor webu Tábora šlapanických divadelníků')
    print('  ==============================================')
    print()

    for port in range(args.port, args.port + 10):     # už běží? jen ho otevřeme
        info = ping(port)
        if info and info.get('app') == 'tsd-editor' and os.path.realpath(info.get('root', '')) == site.root:
            url = 'http://127.0.0.1:%d/' % port
            print('  Editor už běží – otevírám ho v prohlížeči: %s' % url)
            if not args.no_browser:
                webbrowser.open(url)
            return 0

    if not args.no_pull:
        print('  Stahuji nejnovější verzi webu z GitHubu…')
        r = site.git('pull', '--ff-only', timeout=30)
        if r.returncode == 0:
            print('  ✓ Web je aktuální.')
        else:
            print('  ! Novou verzi se stáhnout nepodařilo (nevadí, pokračuji s tou, co je v počítači).')
        print()

    server = None
    for port in range(args.port, args.port + 10):
        try:
            server = EditorServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            continue
    if server is None:
        print('  Nepodařilo se spustit server (porty %d–%d jsou obsazené).' % (args.port, args.port + 9))
        return 1
    server.site = site
    server.port = port
    server.token = secrets.token_urlsafe(24)
    url = 'http://127.0.0.1:%d/' % port

    print('  Editor běží na:  %s' % url)
    print()
    print('  ➜ Nezavírej toto okno, dokud upravuješ.')
    print('  ➜ Až skončíš, klikni v editoru vpravo dole na ⏻ (Ukončit)')
    print('    nebo tady zmáčkni Ctrl+C.')
    print()
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    print()
    print('  Editor je vypnutý.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
