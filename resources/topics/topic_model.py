#!/usr/bin/env python3
"""Topic modeling of the "before" source files collected by WarnPriority.

    python topic_model.py <result.json> [options]

Pipeline
  1. Files: the "before" version of every file in the result JSON
     (<project>/<sha>/before/<oldFile or file>; added files have none).
     Test files (test/ directories, *Test.java, test_*.py, *.spec.ts, ...)
     are left out unless --include-tests is given.
  2. Chunks: each file is split into chunks of code (blocks separated by blank
     lines, merged up to --max-chunk-lines), because a file usually implements
     several functions and long files exceed the model context. License
     headers are dropped. Identical chunks (code that did not change between
     the versions of a file) are embedded and clustered only once, so files
     that were changed often do not dominate the topics.
  3. Embeddings: CodeRankEmbed (nomic-ai/CodeRankEmbed) via sentence-transformers.
  4. Topics: BERTopic (UMAP + HDBSCAN), which chooses the number of topics K.
     Chunks that belong to no topic (HDBSCAN outliers) are counted in a last
     "Unclassified" column (--assign-outliers puts them into their nearest topic).
  5. Keywords: c-TF-IDF over identifiers split into words (getUserName ->
     get user name), without code stopwords (language keywords, common tokens).
  6. Per file: the share of the file's code lines in each topic.

Output (next to the result JSON unless --out is given)
  <result>.topics.csv          File Name, Topic #1 (keywords), ..., Topic #K (keywords)[, Unclassified]
  <result>.topic-keywords.csv  Topic, Keywords (c-TF-IDF), Chunks, Code lines

Progress is printed as "PROGRESS {json}" lines on stdout; everything else goes to stderr.
Heavy libraries are imported only in main(), so the helpers can be tested without them.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from collections import OrderedDict
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------
# Code stopwords: language keywords and tokens common to all code. They carry
# no information about what the code does, so they are left out of the topic
# keywords (c-TF-IDF). Words are compared after identifiers are split and
# lower-cased.
# --------------------------------------------------------------------------

COMMON_STOPWORDS = """
def return self none import from as class if else elif for while try except finally pass break continue true false
public private protected static void null this new const let var function async await include using
get set value values result results args arg param params obj tmp temp index idx len size count item items
str string int integer long short byte char float double bool boolean object array list map
java javax lang util com org net www http https html
todo fixme xxx see link code since author version deprecated override inherit doc docs example
license licensed licenses apache copyright software distributed distribution warranties warranty conditions
governing permissions limitations express implied agreed applicable law writing basis kind obtain copy
""".split()

LANGUAGE_STOPWORDS: Dict[str, str] = {
    'java': """abstract assert boolean break byte case catch char class const continue default do double else enum
        extends final finally float for goto if implements import instanceof int interface long native new package
        private protected public return short static strictfp super switch synchronized this throw throws transient
        try void volatile while var record yield sealed permits true false null suppress warnings functional""",
    'kotlin': """as break class continue do else false for fun if in interface is null object package return super this
        throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally
        get import init param property receiver set where actual abstract annotation companion const crossinline data
        enum expect external final infix inline inner internal lateinit noinline open operator out override private
        protected public reified sealed suspend tailrec vararg it""",
    'scala': """abstract case catch class def do else extends false final finally for if implicit import lazy match new
        null object override package private protected return sealed super this throw trait try true type val var while
        with yield given using then end enum export extension""",
    'groovy': """as assert break case catch class const continue def default do else enum extends false finally for goto
        if implements import in instanceof interface new null package return super switch this throw throws trait true
        try var while""",
    'c': """auto break case char const continue default do double else enum extern float for goto if inline int long
        register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while
        bool true false null nullptr class namespace template typename public private protected virtual override final
        friend operator new delete this throw try catch using include define ifdef ifndef endif pragma std cast noexcept
        constexpr decltype explicit mutable export""",
    'csharp': """abstract as base bool break byte case catch char checked class const continue decimal default delegate
        do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface
        internal is lock long namespace new null object operator out override params private protected public readonly
        ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong
        unchecked unsafe ushort using virtual void volatile while var async await get set value""",
    'go': """break case chan const continue default defer else fallthrough for func go goto if import interface map
        package range return select struct switch type var nil true false err error string int""",
    'rust': """as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod
        move mut pub ref return self static struct super trait true type unsafe use where while some none ok err option
        result vec""",
    'swift': """associatedtype class deinit enum extension fileprivate func import init inout internal let open operator
        private protocol public rethrows static struct subscript typealias var break case continue default defer do else
        fallthrough for guard if in repeat return switch where while as catch false is nil super self throw throws true
        try""",
    'javascript': """break case catch class const continue debugger default delete do else export extends false finally
        for function if import in instanceof new null return super switch this throw true try typeof var void while with
        yield let static enum await implements package protected interface private public async of undefined require
        module exports any number string boolean readonly declare type namespace abstract as from""",
    'php': """abstract and array as break callable case catch class clone const continue declare default do echo else
        elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function
        global goto if implements include once instanceof insteadof interface isset list match namespace new or print
        private protected public readonly require return static switch throw trait try unset use var while xor yield
        true false null this self parent""",
    'python': """false none true and as assert async await break class continue def del elif else except finally for
        from global if import in is lambda nonlocal not or pass raise return try while with yield self cls print len
        range""",
    'ruby': """alias and begin break case class def defined do else elsif end ensure false for if in module next nil not
        or redo rescue retry return self super then true undef unless until when while yield require attr accessor
        puts""",
}

# English function words (as in scikit-learn's list), for comments and names like assertThat / isEmpty.
ENGLISH_STOPWORDS = set("""
a about above after again against all also am an and any are as at be because been before being below between both
but by can could did do does doing down during each either else ever every few for from further had has have having
he her here hers herself him himself his how however if in into is it its itself just may me might more most must
my myself neither no nor not now of off often on once only or other our ours ourselves out over own same shall she
should so some such than that the their theirs them themselves then there these they this those though through thus
to too under until up upon us very was we were what when where whether which while who whom whose why will with
within without would yet you your yours yourself yourselves
""".split())

EXTENSION_LANGUAGE = {
    'java': 'java', 'kt': 'kotlin', 'kts': 'kotlin', 'scala': 'scala', 'groovy': 'groovy',
    'c': 'c', 'h': 'c', 'cc': 'c', 'cpp': 'c', 'cxx': 'c', 'hh': 'c', 'hpp': 'c', 'hxx': 'c', 'm': 'c', 'mm': 'c',
    'cs': 'csharp', 'go': 'go', 'rs': 'rust', 'swift': 'swift',
    'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript', 'ts': 'javascript', 'tsx': 'javascript',
    'php': 'php', 'py': 'python', 'rb': 'ruby',
}


def language_of(path: str) -> Optional[str]:
    return EXTENSION_LANGUAGE.get(os.path.splitext(path)[1].lstrip('.').lower())


def code_stopwords(languages: Iterable[str], extra: Iterable[str] = ()) -> List[str]:
    """Common code tokens + English stop words (comments, assertThat, isEmpty) + the keywords of the
    given languages + extra words, split like identifiers."""
    words = set(COMMON_STOPWORDS) | ENGLISH_STOPWORDS
    for lang in languages:
        words.update(LANGUAGE_STOPWORDS.get(lang, '').split())
    words.update(w for w in extra if w)
    # Apply the same splitting as to the code, so "suppress_warnings" or "isSet" match their tokens.
    return sorted({part for w in words for part in split_identifiers(w).split()})


def split_identifiers(text: str) -> str:
    """getUserName -> get user name, HTTPServer -> http server, MAX_VALUE -> max value; drops digits/punctuation."""
    text = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', text)
    text = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', text)
    text = re.sub(r'[^A-Za-z]+', ' ', text)
    return text.lower()


# --------------------------------------------------------------------------
# Chunking
# --------------------------------------------------------------------------

LICENSE_WORDS = re.compile(r'licen[cs]e|copyright|\(c\)', re.IGNORECASE)

# Import / package / include declarations: they say what a file uses, not what its code does,
# and as separate chunks they would form an artificial "imports" topic.
DECLARATION_LINE = re.compile(
    r'^\s*(package\s|import\s|using\s+[\w.]+\s*;|#\s*(include|import)\b|from\s+[\w.]+\s+import\s|'
    r'use\s+[\w:\\{}, ]+;|require(_relative)?[\s(]|extern\s+crate\s)')


def strip_license_header(lines: List[str]) -> List[str]:
    """Blanks out a leading comment block that is a license / copyright notice (keeps line numbers)."""
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i >= len(lines):
        return lines
    start = i
    first = lines[i].lstrip()
    if first.startswith('/*'):
        while i < len(lines) and '*/' not in lines[i]:
            i += 1
        end = i + 1
    elif first.startswith(('#', '//')) and not first.startswith(('#!', '#include', '#import', '#define', '#pragma')):
        prefix = '#' if first.startswith('#') else '//'
        while i < len(lines) and lines[i].lstrip().startswith(prefix):
            i += 1
        end = i
    else:
        return lines
    if not LICENSE_WORDS.search('\n'.join(lines[start:end])):
        return lines
    return [''] * end + lines[end:]


def chunk_code(text: str, min_lines: int, max_lines: int) -> List[Tuple[str, int]]:
    """Splits code into chunks along blank lines: usually one method (with its doc comment) per chunk.

    Blocks shorter than `min_lines` are merged with the following ones, blocks longer than
    `max_lines` are cut. Boundaries depend only on nearby blocks, so the unchanged parts of two
    versions of a file give identical chunks (which are then embedded only once).
    Returns (chunk text, number of non-blank lines) pairs.
    """
    lines = strip_license_header(text.replace('\r\n', '\n').replace('\r', '\n').split('\n'))
    lines = ['' if DECLARATION_LINE.match(line) else line for line in lines]
    blocks: List[List[str]] = []
    current: List[str] = []
    for line in lines:
        if line.strip():
            current.append(line.rstrip())
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    pieces = [block[k:k + max_lines] for block in blocks for k in range(0, len(block), max_lines)]

    chunks: List[List[str]] = []
    buf: List[str] = []
    for piece in pieces:
        buf.extend(piece)
        if len(buf) >= min_lines:
            chunks.append(buf)
            buf = []
    if buf:
        if chunks and len(chunks[-1]) + len(buf) <= max_lines:
            chunks[-1].extend(buf)  # a short tail (e.g. closing braces) joins the previous chunk
        else:
            chunks.append(buf)
    return [('\n'.join(c), len(c)) for c in chunks]


# --------------------------------------------------------------------------
# Result file and aggregation
# --------------------------------------------------------------------------

TEST_DIRECTORIES = {'test', 'tests', '__tests__', 'testing', 'spec', 'specs', 'androidtest', 'testfixtures',
                    'integrationtest', 'integration-test', 'integration-tests', 'it-test'}
TEST_FILE_NAME = re.compile(
    r'(^test_.*\.py$|_tests?\.py$|^conftest\.py$'            # Python
    r'|_test\.(go|rb|rs|cc|cpp|cxx|c|h|hpp)$|_unittest\.(cc|cpp|c)$|^test_.*\.(c|cc|cpp)$'  # Go, Ruby, Rust, C/C++
    r'|\.(test|spec)\.[cm]?[jt]sx?$|_spec\.rb$'               # JS/TS, Ruby
    r'|(Test|Tests|TestCase|IT|Spec)\.(java|kt|kts|scala|groovy|cs|swift|php|m|mm)$'  # JVM, C#, Swift, PHP, ObjC
    r'|^Test[A-Z_]\w*\.(java|kt|scala|groovy|cs|php)$)')


def is_test_file(repo_path: str) -> bool:
    """Heuristic: the file sits in a test directory or is named like a test in its language."""
    parts = repo_path.replace('\\', '/').split('/')
    if any(p.lower() in TEST_DIRECTORIES for p in parts[:-1]):
        return True
    return bool(TEST_FILE_NAME.search(parts[-1]))


def before_files(result_file: str, include_tests: bool = True) -> Tuple[List[Tuple[str, str]], int]:
    """(name for the CSV, absolute path) of every saved "before" file, in result order, and the
    number of test files left out (when include_tests is False)."""
    with open(result_file, encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, list) or not all(isinstance(c, dict) and 'sha' in c and 'files' in c for c in data):
        raise ValueError(f'{os.path.basename(result_file)} is not a WarnPriority result file')
    project = os.path.dirname(os.path.abspath(result_file))
    out: List[Tuple[str, str]] = []
    skipped_tests = 0
    for commit in data:
        for f in commit['files']:
            repo_path = f.get('oldFile') or f['file']
            rel = f"{commit['sha']}/before/{repo_path}"
            path = os.path.join(project, *rel.split('/'))
            if not os.path.isfile(path):
                continue
            if not include_tests and is_test_file(repo_path):
                skipped_tests += 1
                continue
            out.append((rel, path))
    return out, skipped_tests


def file_topic_shares(chunk_files: Sequence[int], chunk_lines: Sequence[int], chunk_topics: Sequence[int],
                      n_files: int) -> List[Dict[int, float]]:
    """Per file: topic -> percentage of the file's code lines (sums to 100 for files with code)."""
    totals = [0] * n_files
    weights: List[Dict[int, int]] = [dict() for _ in range(n_files)]
    for f, lines, t in zip(chunk_files, chunk_lines, chunk_topics):
        totals[f] += lines
        weights[f][t] = weights[f].get(t, 0) + lines
    return [{t: 100.0 * w / totals[i] for t, w in weights[i].items()} if totals[i] else {} for i in range(n_files)]


UNCLASSIFIED = -1


def topic_columns(topic_ids: Iterable[int], top_words: Dict[int, List[str]], n_keywords: int) -> Tuple[List[int], Dict[int, str]]:
    """Column order and headers: "Topic #1 (keywords)" ... in BERTopic order (0 = largest), then
    "Unclassified" for chunks that belong to no topic, if there are any."""
    ids = sorted(set(topic_ids))
    ordered = [t for t in ids if t != UNCLASSIFIED]
    labels = {t: f"Topic #{n} ({', '.join(top_words.get(t, [])[:n_keywords])})" for n, t in enumerate(ordered, start=1)}
    if UNCLASSIFIED in ids:
        ordered.append(UNCLASSIFIED)
        labels[UNCLASSIFIED] = 'Unclassified'
    return ordered, labels


def write_topics_csv(path: str, file_names: Sequence[str], shares: Sequence[Dict[int, float]],
                     topic_ids: Sequence[int], topic_labels: Dict[int, str]) -> None:
    """File Name, Topic #1 (keywords), ... with percentages; UTF-8 with BOM so Excel reads it."""
    with open(path, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['File Name'] + [topic_labels[t] for t in topic_ids])
        for name, s in zip(file_names, shares):
            w.writerow([name] + [f'{s.get(t, 0.0):.1f}%' for t in topic_ids])


def auto_min_topic_size(distinct_chunks: int) -> int:
    """About 1% of the distinct chunks (at least 10): keeps K readable as the amount of code grows."""
    return max(10, round(distinct_chunks / 100))


def save_cache(path: str, vectors: Dict[str, object]) -> None:
    import numpy as np

    tmp = path + '.tmp.npz'
    np.savez(tmp, keys=np.array(list(vectors.keys())), embeddings=np.vstack(list(vectors.values())))
    os.replace(tmp, path)


def progress(stage: str, **fields) -> None:
    print('PROGRESS ' + json.dumps({'stage': stage, **fields}), flush=True)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('result', help='result JSON written by WarnPriority')
    p.add_argument('--out', help='output CSV (default: <result>.topics.csv)')
    p.add_argument('--model', default='nomic-ai/CodeRankEmbed', help='sentence-transformers embedding model')
    p.add_argument('--min-topic-size', type=int, default=0,
                   help='smallest topic, in code chunks (HDBSCAN min_cluster_size); 0 = automatic: 1%% of the distinct chunks, at least 10')
    p.add_argument('--min-chunk-lines', type=int, default=10, help='blocks shorter than this are merged with the next')
    p.add_argument('--max-chunk-lines', type=int, default=60, help='longer blocks are cut into pieces of this size')
    p.add_argument('--cache-dir', help='embedding cache (default: .topic-embeddings next to the result file)')
    p.add_argument('--max-seq-length', type=int, default=1024, help='tokens per chunk seen by the model')
    p.add_argument('--keywords', type=int, default=5, help='keywords shown in each topic column header')
    p.add_argument('--extra-stopwords', default='', help='comma-separated words to leave out of the keywords')
    p.add_argument('--batch-size', type=int, default=16)
    p.add_argument('--device', default=None, help='cpu, cuda, mps (default: automatic)')
    p.add_argument('--seed', type=int, default=42, help='UMAP random state, for reproducible topics')
    p.add_argument('--assign-outliers', action='store_true',
                   help='put chunks that belong to no topic into their nearest topic instead of an "Unclassified" column')
    p.add_argument('--include-tests', action='store_true', help='also model test files (left out by default)')
    p.add_argument('--nr-topics', default='none', help='"none": the topics HDBSCAN finds (default); "auto": also merge similar topics; or a number')
    args = p.parse_args(argv)

    result_file = os.path.abspath(args.result)
    base = re.sub(r'\.json$', '', result_file, flags=re.IGNORECASE)
    out_csv = os.path.abspath(args.out) if args.out else base + '.topics.csv'
    keywords_csv = re.sub(r'\.csv$', '', out_csv, flags=re.IGNORECASE)
    keywords_csv = (keywords_csv[: -len('.topics')] if keywords_csv.endswith('.topics') else keywords_csv) + '.topic-keywords.csv'

    # 1-2. Files and chunks -------------------------------------------------
    files, skipped_tests = before_files(result_file, include_tests=args.include_tests)
    if skipped_tests:
        log(f'{skipped_tests} test files left out (--include-tests keeps them)')
    if not files:
        raise SystemExit('No "before" files to model' + (' (all of them are test files)' if skipped_tests else ' (only added files?)') + '.')
    progress('read', files=len(files))
    chunk_files: List[int] = []
    chunk_lines: List[int] = []
    chunk_keys: List[str] = []
    unique: 'OrderedDict[str, str]' = OrderedDict()
    for i, (_, path) in enumerate(files):
        with open(path, encoding='utf-8', errors='replace') as f:
            text = f.read()
        for chunk, n in chunk_code(text, args.min_chunk_lines, args.max_chunk_lines):
            key = hashlib.sha1(chunk.encode('utf-8')).hexdigest()
            unique.setdefault(key, chunk)
            chunk_files.append(i)
            chunk_lines.append(n)
            chunk_keys.append(key)
    docs = list(unique.values())
    keys = list(unique.keys())
    log(f'{len(files)} before files, {len(chunk_keys)} chunks, {len(docs)} distinct chunks')
    min_topic_size = args.min_topic_size if args.min_topic_size > 0 else auto_min_topic_size(len(docs))
    log(f'Minimum topic size: {min_topic_size} chunks' + ('' if args.min_topic_size > 0 else ' (automatic)'))
    if len(docs) < max(20, 2 * min_topic_size):
        raise SystemExit(f'Only {len(docs)} distinct code chunks: too few for topic modeling (collect more commits).')

    # 3. Embeddings (cached per chunk hash, model and sequence length) ---------
    import numpy as np

    cache_dir = args.cache_dir or os.path.join(os.path.dirname(result_file), '.topic-embeddings')
    cache_file = os.path.join(cache_dir, re.sub(r'[^A-Za-z0-9._-]+', '_', f'{args.model}-{args.max_seq_length}') + '.npz')
    cached: Dict[str, 'np.ndarray'] = {}
    if os.path.isfile(cache_file):
        with np.load(cache_file) as z:
            cached = dict(zip(z['keys'].tolist(), z['embeddings']))
    missing = [i for i, k in enumerate(keys) if k not in cached]
    log(f'{len(docs) - len(missing)} chunk embeddings cached, {len(missing)} to compute')

    if missing:
        from sentence_transformers import SentenceTransformer

        progress('model', model=args.model)
        model = SentenceTransformer(args.model, trust_remote_code=True, device=args.device)
        model.max_seq_length = args.max_seq_length
        if model.device.type == 'cuda':
            model.half()  # fp16 roughly halves embedding time on GPUs; CPUs stay in fp32
        log(f'Embedding model {args.model} on {model.device}')
        step = max(args.batch_size * 8, 64)
        os.makedirs(cache_dir, exist_ok=True)
        for start in range(0, len(missing), step):
            progress('embed', done=start, total=len(missing))
            batch = missing[start:start + step]
            vectors = model.encode([docs[i] for i in batch], batch_size=args.batch_size,
                                   convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False)
            for i, v in zip(batch, vectors):
                cached[keys[i]] = v.astype(np.float32)
            if (start // step) % 10 == 9:
                save_cache(cache_file, cached)  # keep work done so far if the run is cancelled
        save_cache(cache_file, cached)
        progress('embed', done=len(missing), total=len(missing))
    embeddings = np.vstack([cached[k] for k in keys])

    # 4-5. Topics ---------------------------------------------------------------
    progress('topics')
    import logging
    logging.getLogger('BERTopic').setLevel(logging.ERROR)
    from bertopic import BERTopic
    from bertopic.vectorizers import ClassTfidfTransformer
    from hdbscan import HDBSCAN
    from sklearn.feature_extraction.text import CountVectorizer
    from umap import UMAP

    languages = {language_of(path) for _, path in files} - {None}
    stopwords = code_stopwords(languages, [w.strip() for w in args.extra_stopwords.split(',')])
    # BERTopic strips punctuation before c-TF-IDF without inserting spaces (json.map.put -> jsonmapput),
    # so it gets the code with identifiers already split into words; the embeddings use the real code.
    words = [split_identifiers(d) for d in docs]
    vectorizer = CountVectorizer(token_pattern=r'(?u)\b[a-z]{2,}\b', stop_words=stopwords)
    ctfidf = ClassTfidfTransformer(reduce_frequent_words=True)
    topic_model = BERTopic(
        umap_model=UMAP(n_neighbors=15, n_components=5, min_dist=0.0, metric='cosine', random_state=args.seed),
        hdbscan_model=HDBSCAN(min_cluster_size=min_topic_size, metric='euclidean', cluster_selection_method='eom', prediction_data=True),
        vectorizer_model=vectorizer,
        ctfidf_model=ctfidf,
        top_n_words=10,
        nr_topics=None if args.nr_topics == 'none' else ('auto' if args.nr_topics == 'auto' else int(args.nr_topics)),
    )
    logging.getLogger('BERTopic').setLevel(logging.ERROR)  # BERTopic resets its logger level on construction
    topics, _ = topic_model.fit_transform(words, embeddings)
    found = sorted(set(topics) - {-1})
    if not found:
        raise SystemExit('BERTopic found no topics (every chunk is an outlier). Try a smaller --min-topic-size.')
    outliers = sum(1 for t in topics if t == UNCLASSIFIED)
    if outliers and args.assign_outliers:
        topics = topic_model.reduce_outliers(words, topics, strategy='embeddings', embeddings=embeddings)
        topic_model.update_topics(words, topics=topics, vectorizer_model=vectorizer, ctfidf_model=ctfidf)
    log(f'{len(found)} topics; {outliers} of {len(docs)} distinct chunks belong to no topic ' +
        ('(assigned to their nearest topic)' if args.assign_outliers else '("Unclassified")'))

    # 6. Per-file shares and output ---------------------------------------------
    progress('write')
    topic_of_key = dict(zip(keys, topics))
    chunk_topics = [topic_of_key[k] for k in chunk_keys]
    shares = file_topic_shares(chunk_files, chunk_lines, chunk_topics, len(files))

    scored = {t: topic_model.get_topic(t) or [] for t in set(chunk_topics)}
    topic_ids, labels = topic_columns(chunk_topics, {t: [w for w, _ in ws] for t, ws in scored.items()}, args.keywords)
    keyword_rows = []
    for t in topic_ids:
        lines = sum(l for l, ct in zip(chunk_lines, chunk_topics) if ct == t)
        keyword_rows.append([labels[t].split(' (')[0], ', '.join(f'{w} ({sc:.3f})' for w, sc in scored[t]),
                             sum(1 for x in topics if x == t), lines])

    write_topics_csv(out_csv, [name for name, _ in files], shares, topic_ids, labels)
    with open(keywords_csv, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['Topic', 'Keywords (c-TF-IDF)', 'Distinct chunks', 'Code lines'])
        w.writerows(keyword_rows)

    unclassified = sum(1 for x in topics if x == UNCLASSIFIED)
    progress('done', topics=len(found), files=len(files), testFiles=skipped_tests, chunks=len(chunk_keys),
             uniqueChunks=len(docs), outliers=outliers, unclassifiedChunks=unclassified, csv=out_csv, keywordsCsv=keywords_csv)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
