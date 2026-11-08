#!/usr/bin/env python3
"""Topic modeling of the "before" source files collected by WarnPriority.

    python topic_model.py <result.json> [options]

Pipeline
  1. Files: the "before" version of every file in the result JSON
     (<project>/<sha>/before/<oldFile or file>; added files have none).
  2. Chunks: each file is split into chunks of code (blocks separated by blank
     lines, merged up to --max-chunk-lines), because a file usually implements
     several functions and long files exceed the model context. License
     headers are dropped. Identical chunks (code that did not change between
     the versions of a file) are embedded and clustered only once, so files
     that were changed often do not dominate the topics.
  3. Embeddings: CodeRankEmbed (nomic-ai/CodeRankEmbed) via sentence-transformers.
  4. Topics: BERTopic (UMAP + HDBSCAN), which chooses the number of topics K.
     Outlier chunks are assigned to their nearest topic (--keep-outliers keeps them).
  5. Keywords: c-TF-IDF over identifiers split into words (getUserName ->
     get user name), without code stopwords (language keywords, common tokens).
  6. Per file: the share of the file's code lines in each topic.

Output (next to the result JSON unless --out is given)
  <result>.topics.csv          File Name, Topic #1 (keywords), ..., Topic #K (keywords)
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
    """Common code tokens + the keywords of the given languages + extra words, split like identifiers."""
    words = set(COMMON_STOPWORDS)
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


def chunk_code(text: str, max_lines: int) -> List[Tuple[str, int]]:
    """Splits code into chunks of at most `max_lines` non-blank lines, cut at blank lines where possible.

    Returns (chunk text, number of non-blank lines) pairs.
    """
    lines = strip_license_header(text.replace('\r\n', '\n').replace('\r', '\n').split('\n'))
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

    # A block longer than max_lines is cut into pieces.
    pieces: List[List[str]] = []
    for block in blocks:
        for k in range(0, len(block), max_lines):
            pieces.append(block[k:k + max_lines])

    chunks: List[Tuple[str, int]] = []
    buf: List[str] = []
    for piece in pieces:
        if buf and len(buf) + len(piece) > max_lines:
            chunks.append(('\n'.join(buf), len(buf)))
            buf = []
        buf.extend(piece)
    if buf:
        chunks.append(('\n'.join(buf), len(buf)))
    return chunks


# --------------------------------------------------------------------------
# Result file and aggregation
# --------------------------------------------------------------------------

def before_files(result_file: str) -> List[Tuple[str, str]]:
    """(name for the CSV, absolute path) of every saved "before" file, in result order."""
    with open(result_file, encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, list) or not all(isinstance(c, dict) and 'sha' in c and 'files' in c for c in data):
        raise ValueError(f'{os.path.basename(result_file)} is not a WarnPriority result file')
    project = os.path.dirname(os.path.abspath(result_file))
    out: List[Tuple[str, str]] = []
    for commit in data:
        for f in commit['files']:
            rel = f"{commit['sha']}/before/{f.get('oldFile') or f['file']}"
            path = os.path.join(project, *rel.split('/'))
            if os.path.isfile(path):
                out.append((rel, path))
    return out


def file_topic_shares(chunk_files: Sequence[int], chunk_lines: Sequence[int], chunk_topics: Sequence[int],
                      n_files: int) -> List[Dict[int, float]]:
    """Per file: topic -> percentage of the file's code lines (sums to 100 for files with code)."""
    totals = [0] * n_files
    weights: List[Dict[int, int]] = [dict() for _ in range(n_files)]
    for f, lines, t in zip(chunk_files, chunk_lines, chunk_topics):
        totals[f] += lines
        weights[f][t] = weights[f].get(t, 0) + lines
    return [{t: 100.0 * w / totals[i] for t, w in weights[i].items()} if totals[i] else {} for i in range(n_files)]


def write_topics_csv(path: str, file_names: Sequence[str], shares: Sequence[Dict[int, float]],
                     topic_ids: Sequence[int], topic_labels: Dict[int, str]) -> None:
    """File Name, Topic #1 (keywords), ... with percentages; UTF-8 with BOM so Excel reads it."""
    with open(path, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['File Name'] + [topic_labels[t] for t in topic_ids])
        for name, s in zip(file_names, shares):
            w.writerow([name] + [f'{s.get(t, 0.0):.1f}%' for t in topic_ids])


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
    p.add_argument('--min-topic-size', type=int, default=10, help='smallest topic, in code chunks (HDBSCAN min_cluster_size)')
    p.add_argument('--max-chunk-lines', type=int, default=60, help='code lines per chunk')
    p.add_argument('--max-seq-length', type=int, default=1024, help='tokens per chunk seen by the model')
    p.add_argument('--keywords', type=int, default=5, help='keywords shown in each topic column header')
    p.add_argument('--extra-stopwords', default='', help='comma-separated words to leave out of the keywords')
    p.add_argument('--batch-size', type=int, default=16)
    p.add_argument('--device', default=None, help='cpu, cuda, mps (default: automatic)')
    p.add_argument('--seed', type=int, default=42, help='UMAP random state, for reproducible topics')
    p.add_argument('--keep-outliers', action='store_true', help='keep chunks HDBSCAN marks as outliers in an "Outliers" column')
    args = p.parse_args(argv)

    result_file = os.path.abspath(args.result)
    base = re.sub(r'\.json$', '', result_file, flags=re.IGNORECASE)
    out_csv = os.path.abspath(args.out) if args.out else base + '.topics.csv'
    keywords_csv = re.sub(r'\.csv$', '', out_csv, flags=re.IGNORECASE)
    keywords_csv = (keywords_csv[: -len('.topics')] if keywords_csv.endswith('.topics') else keywords_csv) + '.topic-keywords.csv'

    # 1-2. Files and chunks -------------------------------------------------
    files = before_files(result_file)
    if not files:
        raise SystemExit('The result file lists no saved "before" files (only added files?).')
    progress('read', files=len(files))
    chunk_files: List[int] = []
    chunk_lines: List[int] = []
    chunk_keys: List[str] = []
    unique: 'OrderedDict[str, str]' = OrderedDict()
    for i, (_, path) in enumerate(files):
        with open(path, encoding='utf-8', errors='replace') as f:
            text = f.read()
        for chunk, n in chunk_code(text, args.max_chunk_lines):
            key = hashlib.sha1(chunk.encode('utf-8')).hexdigest()
            unique.setdefault(key, chunk)
            chunk_files.append(i)
            chunk_lines.append(n)
            chunk_keys.append(key)
    docs = list(unique.values())
    keys = list(unique.keys())
    log(f'{len(files)} before files, {len(chunk_keys)} chunks, {len(docs)} distinct chunks')
    if len(docs) < max(20, 2 * args.min_topic_size):
        raise SystemExit(f'Only {len(docs)} distinct code chunks: too few for topic modeling (collect more commits).')

    # 3. Embeddings -----------------------------------------------------------
    import numpy as np
    from sentence_transformers import SentenceTransformer

    progress('model', model=args.model)
    model = SentenceTransformer(args.model, trust_remote_code=True, device=args.device)
    model.max_seq_length = args.max_seq_length
    if model.device.type == 'cuda':
        model.half()  # fp16 roughly halves embedding time on GPUs; CPUs stay in fp32
    log(f'Embedding model {args.model} on {model.device}')
    embeddings = []
    step = max(args.batch_size * 8, 64)
    for start in range(0, len(docs), step):
        progress('embed', done=start, total=len(docs))
        embeddings.append(model.encode(docs[start:start + step], batch_size=args.batch_size,
                                       convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False))
    embeddings = np.vstack(embeddings)
    progress('embed', done=len(docs), total=len(docs))

    # 4-5. Topics ---------------------------------------------------------------
    progress('topics')
    from bertopic import BERTopic
    from bertopic.vectorizers import ClassTfidfTransformer
    from hdbscan import HDBSCAN
    from sklearn.feature_extraction.text import CountVectorizer
    from umap import UMAP

    languages = {language_of(path) for _, path in files} - {None}
    stopwords = code_stopwords(languages, [w.strip() for w in args.extra_stopwords.split(',')])
    vectorizer = CountVectorizer(preprocessor=split_identifiers, token_pattern=r'(?u)\b[a-z]{2,}\b', stop_words=stopwords)
    ctfidf = ClassTfidfTransformer(reduce_frequent_words=True)
    topic_model = BERTopic(
        umap_model=UMAP(n_neighbors=15, n_components=5, min_dist=0.0, metric='cosine', random_state=args.seed),
        hdbscan_model=HDBSCAN(min_cluster_size=args.min_topic_size, metric='euclidean', cluster_selection_method='eom', prediction_data=True),
        vectorizer_model=vectorizer,
        ctfidf_model=ctfidf,
        top_n_words=10,
    )
    topics, _ = topic_model.fit_transform(docs, embeddings)
    found = sorted(set(topics) - {-1})
    if not found:
        raise SystemExit('BERTopic found no topics (every chunk is an outlier). Try a smaller --min-topic-size.')
    outliers = sum(1 for t in topics if t == -1)
    if outliers and not args.keep_outliers:
        topics = topic_model.reduce_outliers(docs, topics, strategy='embeddings', embeddings=embeddings)
        topic_model.update_topics(docs, topics=topics, vectorizer_model=vectorizer, ctfidf_model=ctfidf)
    log(f'{len(found)} topics; {outliers} outlier chunks ' + ('kept' if args.keep_outliers else 'assigned to their nearest topic'))

    # 6. Per-file shares and output ---------------------------------------------
    progress('write')
    topic_of_key = dict(zip(keys, topics))
    chunk_topics = [topic_of_key[k] for k in chunk_keys]
    shares = file_topic_shares(chunk_files, chunk_lines, chunk_topics, len(files))

    # Topics in BERTopic order (0 = largest); "Topic #1" is topic 0.
    topic_ids = sorted(set(chunk_topics) - {-1})
    labels: Dict[int, str] = {}
    keyword_rows = []
    for n, t in enumerate(topic_ids, start=1):
        words = topic_model.get_topic(t) or []
        labels[t] = f"Topic #{n} ({', '.join(w for w, _ in words[: args.keywords])})"
        lines = sum(l for l, ct in zip(chunk_lines, chunk_topics) if ct == t)
        keyword_rows.append([f'Topic #{n}', ', '.join(f'{w} ({s:.3f})' for w, s in words), sum(1 for x in topics if x == t), lines])
    if -1 in chunk_topics:
        topic_ids.append(-1)
        labels[-1] = 'Outliers'

    write_topics_csv(out_csv, [name for name, _ in files], shares, topic_ids, labels)
    with open(keywords_csv, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['Topic', 'Keywords (c-TF-IDF)', 'Distinct chunks', 'Code lines'])
        w.writerows(keyword_rows)

    progress('done', topics=len(found), files=len(files), chunks=len(chunk_keys), uniqueChunks=len(docs),
             outliers=outliers, csv=out_csv, keywordsCsv=keywords_csv)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
