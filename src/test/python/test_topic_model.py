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

    def test_english_function_words(self):
        words = set(tm.code_stopwords([]))
        for w in ['that', 'is', 'to', 'the']:
            self.assertIn(w, words)
        self.assertNotIn('json', words)

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
    def test_blocks_become_chunks_and_small_blocks_merge(self):
        text = '\n'.join(['a1', 'a2', '', 'b1', 'b2', 'b3', '', '', 'c1', 'c2', 'c3', 'c4', 'c5', '', 'd1'])
        # a (2 lines) + b (3) reach 5 lines; c (5) is a chunk; the short tail d joins it.
        self.assertEqual(tm.chunk_code(text, 5, 60), [('a1\na2\nb1\nb2\nb3', 5), ('c1\nc2\nc3\nc4\nc5\nd1', 6)])

    def test_long_block_is_cut(self):
        text = '\n'.join(f'l{i}' for i in range(7))
        self.assertEqual([n for _, n in tm.chunk_code(text, 1, 3)], [3, 3, 1])

    def test_unchanged_methods_give_identical_chunks_across_versions(self):
        method = lambda name: [f'void {name}() {{'] + [f'  step{i}();' for i in range(10)] + ['}', '']
        chunks = lambda lines: {c for c, _ in tm.chunk_code('\n'.join(lines), 10, 60)}
        v1 = chunks(method('a') + method('b') + method('c'))
        # A line edited inside a(): b() and c() are the same chunks as before.
        edited = method('a')
        edited[3] = '  changed();'
        v2 = chunks(edited + method('b') + method('c'))
        self.assertEqual(len(v1 & v2), 2)
        # A small block inserted before b(): only the chunk it merges into (b) changes; c() is untouched.
        v3 = chunks(method('a') + ['  // new comment', ''] + method('b') + method('c'))
        self.assertEqual({c for c in v1 if 'void c' in c or 'void a' in c}, {c for c in v1 & v3})

    def test_license_and_crlf(self):
        text = '/*\r\n * Licensed under MIT\r\n */\r\nclass A {\r\n}\r\n'
        self.assertEqual(tm.chunk_code(text, 10, 60), [('class A {\n}', 2)])

    def test_import_and_package_lines_are_dropped(self):
        java = 'package a.b;\n\nimport java.util.List;\nimport static x.Y.z;\n\nclass A {\n  int f() { return 1; }\n}\n'
        self.assertEqual(tm.chunk_code(java, 10, 60), [('class A {\n  int f() { return 1; }\n}', 3)])
        py = 'import os\nfrom a.b import c\n\ndef f():\n    return os.sep\n'
        self.assertEqual(tm.chunk_code(py, 10, 60), [('def f():\n    return os.sep', 2)])
        self.assertEqual(tm.chunk_code('#include <stdio.h>\nusing System;\nint important = 1;', 10, 60), [('int important = 1;', 1)])

    def test_empty(self):
        self.assertEqual(tm.chunk_code('\n\n', 10, 60), [])


class TestFiles(unittest.TestCase):
    def test_test_files_by_directory_and_name(self):
        for p in ['gson/src/test/java/com/google/gson/GsonTest.java', 'src/test/java/A.java', 'app/src/androidTest/Foo.kt',
                  'pkg/__tests__/x.js', 'tests/test_api.py', 'lib/util_test.go', 'web/app.spec.ts', 'ui/button.test.tsx',
                  'spec/models/user_spec.rb', 'Core/ParserTests.cs', 'src/FooIT.java', 'src/TestHelper.java', 'conftest.py',
                  'base/strings_unittest.cc']:
            self.assertTrue(tm.is_test_file(p), p)
        for p in ['gson/src/main/java/com/google/gson/Gson.java', 'src/Contest.java', 'src/Testable.java', 'src/latest.py',
                  'lib/attestation.go', 'src/main/java/Specification.java', 'web/inspect.ts']:
            self.assertFalse(tm.is_test_file(p), p)

    def test_before_files_can_leave_out_tests(self):
        with tempfile.TemporaryDirectory() as d:
            for rel in ['abc/before/src/main/A.java', 'abc/before/src/test/ATest.java']:
                os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
                open(os.path.join(d, rel), 'w').close()
            result = [{'sha': 'abc', 'files': [{'file': 'src/main/A.java', 'diff': []}, {'file': 'src/test/ATest.java', 'diff': []}]}]
            path = os.path.join(d, 'r.json')
            with open(path, 'w') as f:
                json.dump(result, f)
            files, skipped = tm.before_files(path, include_tests=False)
            self.assertEqual(([n for n, _ in files], skipped), (['abc/before/src/main/A.java'], 1))
            self.assertEqual(len(tm.before_files(path, include_tests=True)[0]), 2)


class Aggregation(unittest.TestCase):
    def test_topic_columns_put_unclassified_last(self):
        ids, labels = tm.topic_columns([1, -1, 0, 1, 0], {0: ['json', 'reader', 'x'], 1: ['date'], -1: ['misc']}, 2)
        self.assertEqual(ids, [0, 1, -1])
        self.assertEqual([labels[t] for t in ids], ['Topic #1 (json, reader)', 'Topic #2 (date)', 'Unclassified'])
        ids, labels = tm.topic_columns([0, 1], {0: ['a'], 1: ['b']}, 5)
        self.assertEqual(ids, [0, 1], 'no Unclassified column without unclassified code')


    def test_shares_are_weighted_by_code_lines(self):
        shares = tm.file_topic_shares([0, 0, 0, 1], [30, 10, 60, 5], [2, 0, 2, 1], 3)
        self.assertEqual(shares[0], {2: 90.0, 0: 10.0})
        self.assertEqual(shares[1], {1: 100.0})
        self.assertEqual(shares[2], {})

    def test_auto_min_topic_size(self):
        self.assertEqual(tm.auto_min_topic_size(300), 10)
        self.assertEqual(tm.auto_min_topic_size(3239), 32)
        self.assertEqual(tm.auto_min_topic_size(11749), 117)

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
            files, skipped = tm.before_files(path)
            self.assertEqual(([n for n, _ in files], skipped), (['abc/before/src/Old.java'], 0))
            with open(path, 'w') as f:
                json.dump({'not': 'a result'}, f)
            with self.assertRaises(ValueError):
                tm.before_files(path)


if __name__ == '__main__':
    unittest.main()
