"""Unit tests for resources/topics/topic_model.py helpers (standard library only)."""

import csv
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'resources', 'topics'))
import topic_model as tm  # noqa: E402


class SplitIdentifiers(unittest.TestCase):
    def test_camel_snake_and_acronyms(self):
        self.assertEqual(tm.split_identifiers('getUserName').split(), ['get', 'user', 'name'])
        self.assertEqual(tm.split_identifiers('HTTPServer').split(), ['http', 'server'])
        self.assertEqual(tm.split_identifiers('MAX_VALUE + parseInt2(x)').split(), ['max', 'value', 'parse', 'int', 'x'])


class Stopwords(unittest.TestCase):
    def test_user_examples_and_language_keywords(self):
        words = set(tm.code_stopwords(['java', 'python']))
        for w in ['def', 'return', 'self', 'none', 'null', 'public', 'void', 'this', 'synchronized', 'elif', 'lambda']:
            self.assertIn(w, words)
        self.assertNotIn('fn', words, 'Rust keyword only when Rust files are present')
        self.assertIn('fn', tm.code_stopwords(['rust']))

    def test_extra_words_are_split_like_code(self):
        words = tm.code_stopwords([], ['myHelper', ''])
        self.assertIn('my', words)
        self.assertIn('helper', words)

    def test_language_of(self):
        self.assertEqual(tm.language_of('a/B.java'), 'java')
        self.assertEqual(tm.language_of('x.TSX'), 'javascript')
        self.assertIsNone(tm.language_of('README.md'))


class LicenseHeader(unittest.TestCase):
    def test_block_comment_license_is_blanked(self):
        lines = ['/*', ' * Copyright (C) 2008 Google Inc.', ' * Licensed under the Apache License', ' */', 'package x;']
        self.assertEqual(tm.strip_license_header(lines), ['', '', '', '', 'package x;'])

    def test_hash_comment_license_is_blanked_but_shebang_kept(self):
        self.assertEqual(tm.strip_license_header(['# Copyright 2020 X', '# MIT License', 'import os']), ['', '', 'import os'])
        self.assertEqual(tm.strip_license_header(['#!/usr/bin/env python', 'import os']), ['#!/usr/bin/env python', 'import os'])

    def test_other_leading_comments_are_kept(self):
        lines = ['/** Parses JSON. */', 'class A {}']
        self.assertEqual(tm.strip_license_header(lines), lines)


class Chunking(unittest.TestCase):
    def test_blocks_merge_up_to_max_lines_at_blank_lines(self):
        text = '\n'.join(['a1', 'a2', '', 'b1', 'b2', 'b3', '', '', 'c1'])
        self.assertEqual(tm.chunk_code(text, 5), [('a1\na2\nb1\nb2\nb3', 5), ('c1', 1)])

    def test_long_block_is_cut(self):
        text = '\n'.join(f'l{i}' for i in range(7))
        self.assertEqual([n for _, n in tm.chunk_code(text, 3)], [3, 3, 1])

    def test_license_and_crlf(self):
        text = '/*\r\n * Licensed under MIT\r\n */\r\nclass A {\r\n}\r\n'
        self.assertEqual(tm.chunk_code(text, 60), [('class A {\n}', 2)])

    def test_empty(self):
        self.assertEqual(tm.chunk_code('\n\n', 10), [])


class Aggregation(unittest.TestCase):
    def test_shares_are_weighted_by_code_lines(self):
        shares = tm.file_topic_shares([0, 0, 0, 1], [30, 10, 60, 5], [2, 0, 2, 1], 3)
        self.assertEqual(shares[0], {2: 90.0, 0: 10.0})
        self.assertEqual(shares[1], {1: 100.0})
        self.assertEqual(shares[2], {})

    def test_csv_format(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'x.topics.csv')
            labels = {0: 'Topic #1 (json, reader)', 1: 'Topic #2 (type, adapter)'}
            tm.write_topics_csv(path, ['sha/before/A.java'], [{1: 64.0, 0: 36.0}], [0, 1], labels)
            with open(path, encoding='utf-8-sig', newline='') as f:
                rows = list(csv.reader(f))
            self.assertEqual(rows, [['File Name', 'Topic #1 (json, reader)', 'Topic #2 (type, adapter)'],
                                    ['sha/before/A.java', '36.0%', '64.0%']])

    def test_before_files_lists_saved_before_versions(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, 'abc', 'before', 'src'))
            open(os.path.join(d, 'abc', 'before', 'src', 'Old.java'), 'w').close()
            result = [{'sha': 'abc', 'files': [
                {'file': 'src/New.java', 'oldFile': 'src/Old.java', 'diff': []},   # renamed: before/ uses the old path
                {'file': 'src/Added.java', 'diff': []},                             # added: no before version
            ]}]
            path = os.path.join(d, 'r.json')
            with open(path, 'w') as f:
                json.dump(result, f)
            self.assertEqual([n for n, _ in tm.before_files(path)], ['abc/before/src/Old.java'])
            with open(path, 'w') as f:
                json.dump({'not': 'a result'}, f)
            with self.assertRaises(ValueError):
                tm.before_files(path)


if __name__ == '__main__':
    unittest.main()
