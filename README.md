# WarnPriority

GitHub 저장소의 커밋 이력에서 **커밋 메시지에 특정 키워드가 들어간 커밋**을 찾아, 그 커밋에서 **수정·삽입·삭제된 코드만** 추출해 파일(JSON/CSV)로 저장하는 VS Code 확장입니다.

## 사용법

1. 명령 팔레트(`Ctrl+Shift+P` / `Cmd+Shift+P`)에서 **`WarnPriority: GitHub 커밋에서 변경된 코드 수집`**
   (영문 UI: `WarnPriority: Collect Changed Code from GitHub Commits`)을 실행합니다.
2. **GitHub 주소**를 입력합니다. 예: `https://github.com/google/gson`
3. **커밋 메시지 키워드**를 입력합니다. 예: `fix, bug`
4. 진행 상황이 알림으로 표시되고(취소 가능), 완료되면 결과 파일을 열 수 있습니다.

결과 파일은 기본적으로 `<워크스페이스>/warnpriority-output/` 아래에
`<owner>_<repo>_<키워드>_<날짜-시간>.json` 이름으로 저장됩니다.
열린 폴더가 없으면 저장 위치를 묻습니다.

### 입력 가능한 주소 형식

| 형식 | 예 |
| --- | --- |
| 저장소 URL | `https://github.com/owner/repo`, `https://github.com/owner/repo.git` |
| 브랜치/커밋 이력 페이지 | `https://github.com/owner/repo/tree/dev`, `.../commits/dev` → 해당 브랜치의 이력을 검색 |
| 축약형 | `owner/repo`, `github.com/owner/repo` |
| SSH | `git@github.com:owner/repo.git` |
| 기타 | GitHub Enterprise·GitLab 등 `https://host/group/repo`, 로컬 저장소 경로 |

주소에 브랜치가 없으면 기본 브랜치(예: `main`)의 이력을 검색합니다.

### 키워드 규칙

- 쉼표로 여러 개를 입력하면 **하나라도 포함된** 커밋을 찾습니다(OR). 예: `fix, bug, error`
- 기본은 **대소문자 무시 + 부분 문자열 일치**입니다. (`fix`는 `Fix`, `bugfix`, `fixed`와도 일치)
- 제목뿐 아니라 커밋 메시지 본문 전체에서 검색합니다.
- 비워 두면 모든 커밋을 수집합니다.
- 단어 단위로 정확히 찾고 싶으면 `warnPriority.useRegex`를 켜고 `\bfix(e[sd])?\b`처럼 정규식을 입력하세요.

## 변경 유형(수정·삽입·삭제)

diff의 문맥 줄은 버리고 **바뀐 줄만** 남긴 뒤, 연속된 변경 줄 묶음(블록) 하나를 다음 중 하나로 분류합니다.

| `type` | 의미 | 담기는 코드 |
| --- | --- | --- |
| `modify` (수정) | 기존 줄이 삭제되고 그 자리에 다른 줄이 들어감 | `deletedCode`(변경 전) + `addedCode`(변경 후) |
| `insert` (삽입) | 줄이 추가되기만 함 | `addedCode` |
| `delete` (삭제) | 줄이 삭제되기만 함 | `deletedCode` |

줄 번호(`oldStart`/`newStart`)는 각각 변경 전/후 파일 기준이며, git diff의 hunk 헤더 규칙을 따릅니다.
`insert`의 `oldStart`는 "변경 전 파일에서 몇 번째 줄 **뒤에** 삽입됐는지"(0 = 파일 맨 앞), `delete`의 `newStart`는 "변경 후 파일에서 몇 번째 줄 뒤에 있던 코드인지"를 뜻합니다.

바이너리 파일, 내용 변경 없는 이름 변경/권한 변경은 코드 변경이 없으므로 제외됩니다.

## 출력 형식

### JSON (기본)

```jsonc
{
  "metadata": {
    "repository": { "url": "https://github.com/google/gson", "ref": "main", "headCommit": "65df6e5…" },
    "query": { "keywords": ["fix", "bug"], "matchMode": "substring", "caseSensitive": false, "fileExtensions": ["java"] }
  },
  "commits": [
    {
      "sha": "094f5003…",
      "parents": ["…"],
      "author": { "name": "…", "email": "…", "date": "2024-06-01T12:34:56+02:00" },
      "committer": { "name": "…", "email": "…", "date": "…" },
      "message": "Fix typo in comment (#3148)",
      "url": "https://github.com/google/gson/commit/094f5003…",
      "stats": { "filesChanged": 1, "linesAdded": 1, "linesDeleted": 1, "modifyBlocks": 1, "insertBlocks": 0, "deleteBlocks": 0 },
      "files": [
        {
          "oldPath": "gson/src/main/java/com/google/gson/Gson.java",
          "newPath": "gson/src/main/java/com/google/gson/Gson.java",
          "status": "modified",          // added | deleted | modified | renamed | copied
          "changes": [
            {
              "type": "modify",
              "oldStart": 1118, "oldLines": 1,
              "newStart": 1118, "newLines": 1,
              "deletedCode": ["       * For compatibility with JSON 1.5 and earlier, we return null for empty"],
              "addedCode":   ["       * For compatibility with Gson 1.5 and earlier, we return null for empty"]
            }
          ]
        }
      ]
    }
  ],
  "summary": {
    "complete": true,                 // 중간에 취소하면 false (그때까지의 결과는 저장됨)
    "matchedCommits": 381, "commitsWithCodeChanges": 380, "filesChanged": 1654,
    "codeChanges": { "modify": 5798, "insert": 1570, "delete": 576, "total": 7944 },
    "linesAdded": 36198, "linesDeleted": 18085
  }
}
```

### CSV

`warnPriority.outputFormat`을 `csv`로 바꾸면 **변경 블록 하나당 한 행**으로 저장합니다(UTF-8 BOM 포함, Excel에서 바로 열림).
컬럼: `commit_sha, commit_url, author_name, author_email, author_date, commit_message, file_status, old_path, new_path, change_type, old_start, old_lines, new_start, new_lines, deleted_code, added_code`

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `warnPriority.outputDirectory` | `""` | 결과 저장 폴더. 비우면 `<워크스페이스>/warnpriority-output` |
| `warnPriority.outputFormat` | `json` | `json` 또는 `csv` |
| `warnPriority.fileExtensions` | `[]` | 특정 확장자 파일만 수집. 예: `["java"]` |
| `warnPriority.maxCommits` | `0` | 최대 커밋 수(최신순). `0` = 제한 없음 |
| `warnPriority.caseSensitive` | `false` | 키워드 대소문자 구분 |
| `warnPriority.useRegex` | `false` | 키워드를 정규식(POSIX 확장)으로 처리 |
| `warnPriority.includeMergeCommits` | `false` | 머지 커밋 포함(첫 번째 부모 기준 diff, Git 2.31+) |
| `warnPriority.ignoreWhitespace` | `false` | 공백만 바뀐 변경 무시 |
| `warnPriority.gitPath` | `""` | Git 실행 파일 경로. 비우면 VS Code Git 확장이 쓰는 Git 사용 |

## 동작 방식

- GitHub REST API 대신 **`git clone --bare`** 로 저장소를 받아 로컬에서 `git log --grep … -p`로 분석합니다.
  API는 인증 없이 시간당 60회로 제한돼 커밋이 많은 저장소를 분석할 수 없지만, git은 제한 없이 수만 개 커밋도 처리합니다.
- 받은 저장소는 VS Code 확장 저장 공간에 캐시되어, 다음 실행부터는 `git fetch`로 새 커밋만 받습니다.
  디스크를 비우려면 **`WarnPriority: 캐시된 저장소 복제본 삭제`** 명령을 실행하세요.
- 결과는 커밋 단위로 스트리밍 저장되므로 대형 저장소에서도 메모리 사용량이 일정합니다.
- 비공개 저장소는 PC에 설정된 Git 자격 증명(Git Credential Manager, SSH 키 등)으로 접근합니다.

**요구 사항:** [Git](https://git-scm.com/) 설치 (VS Code Git 확장과 같은 Git을 사용)

## 개발

```bash
npm install
npm run compile      # 또는 npm run watch
npm test             # 단위 + 통합 테스트 (로컬 임시 저장소 사용, 네트워크 불필요)
```

- VS Code에서 이 폴더를 열고 **F5**를 누르면 확장이 로드된 새 창(Extension Development Host)이 열립니다.
- VS Code 없이 같은 기능을 CLI로 실행할 수도 있습니다(일괄 수집에 유용):

  ```bash
  npm run collect -- https://github.com/google/gson "fix,bug" --ext java --format csv --out gson.csv
  ```

  옵션: `--out <파일>`, `--format json|csv`, `--ext java,py`, `--max N`, `--case-sensitive`, `--regex`, `--merges`, `--ignore-ws`, `--cache <폴더>`(기본 `~/.warnpriority/repos`), `--git <경로>`

- `.vsix` 패키지 만들기: `npm run package` (LICENSE 파일이 없으면 계속할지 묻습니다)

### 구조

```
src/
├─ extension.ts        VS Code 명령, 입력창, 진행 표시, 결과 알림
├─ cli.ts              CLI 진입점
└─ core/               VS Code에 의존하지 않는 수집 로직
   ├─ githubUrl.ts     주소 파싱 (URL/SSH/축약형/브랜치 URL)
   ├─ repoCache.ts     bare clone 캐시, fetch, 브랜치 해석
   ├─ git.ts           git 프로세스 실행/스트리밍, 취소 처리
   ├─ logParser.ts     git log -p 출력 스트리밍 파서 → 수정/삽입/삭제 블록
   ├─ writers.ts       JSON/CSV 스트리밍 저장
   ├─ collector.ts     전체 파이프라인
   └─ types.ts         결과 데이터 모델
l10n/, package.nls*.json   영어/한국어 UI 문자열 (VS Code 표시 언어에 따라 자동 선택)
```
