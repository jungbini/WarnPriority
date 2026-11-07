# WarnPriority

GitHub 저장소의 커밋 이력에서 **커밋 메시지에 특정 키워드가 들어간 커밋**을 찾아, 그 커밋에서 **추가·삭제·수정된 코드만** 추출해 JSON 파일로 저장하는 VS Code 확장입니다.

## 사용법

1. 명령 팔레트(`Ctrl+Shift+P` / `Cmd+Shift+P`)에서 **`WarnPriority: GitHub 커밋에서 변경된 코드 수집`**
   (영문 UI: `WarnPriority: Collect Changed Code from GitHub Commits`)을 실행합니다.
2. **GitHub 주소**를 입력합니다. 예: `https://github.com/google/gson`
3. **커밋 메시지 키워드**를 입력합니다. 예: `fix, bug`
4. 진행 상황이 알림으로 표시되고(취소 가능), 완료되면 결과 파일이 **VS Code 에디터에서 자동으로 열립니다.**

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

## 결과 파일 형식

커밋 하나당 항목 하나인 **JSON 배열**이며, 아래 정보만 저장합니다.

| 필드 | 내용 |
| --- | --- |
| `sha` | 커밋 SHA |
| `parent` | 부모 커밋 SHA (diff 비교 기준인 첫 번째 부모, 최초 커밋이면 `null`) |
| `author` | 작성자 `이름 <이메일>` |
| `message` | 커밋 메시지 전체 |
| `files[].file` | 커밋 후 파일 경로 (삭제된 파일은 삭제 전 경로) |
| `files[].oldFile` | 커밋 전 파일 경로 — **이름이 바뀐 파일에만** 있음 |
| `files[].diff` | 그 파일에서 추가·삭제·수정된 소스코드와 줄 번호 (아래) |

```json
[
  {
    "sha": "094f5003ce5f6d2fb65457bee9c78b9d53d25308",
    "parent": "881d2b55de74dd6c2fded7b2cb307b048117af97",
    "author": "Marcono1234 <Marcono1234@users.noreply.github.com>",
    "message": "Fix typo in comment (#3148)",
    "files": [
      {
        "file": "gson/src/main/java/com/google/gson/Gson.java",
        "diff": [
          {
            "type": "modified",
            "before": [ { "line": 1118, "code": "       * For compatibility with JSON 1.5 and earlier, we return null for empty" } ],
            "after":  [ { "line": 1118, "code": "       * For compatibility with Gson 1.5 and earlier, we return null for empty" } ]
          },
          { "type": "added",   "before": [], "after": [ { "line": 1200, "code": "..." } ] },
          { "type": "deleted", "before": [ { "line": 1300, "code": "..." } ], "after": [] }
        ]
      }
    ]
  }
]
```

### 변경 유형과 줄 번호 (`diff[]`)

diff의 문맥 줄은 버리고 **바뀐 줄만** 남긴 뒤, 연속된 변경 줄 묶음 하나를 다음 중 하나로 분류합니다.

| `type` | 의미 | `before` | `after` |
| --- | --- | --- | --- |
| `added` (추가) | 줄이 추가되기만 함 | `[]` | 추가된 줄 |
| `deleted` (삭제) | 줄이 삭제되기만 함 | 삭제된 줄 | `[]` |
| `modified` (수정) | 기존 줄이 삭제되고 그 자리에 다른 줄이 들어감 | 변경 전 줄 | 변경 후 줄 |

- 각 줄은 `{ "line": 줄 번호, "code": 코드 }` 형태입니다.
- `before`의 줄 번호는 **커밋 전 파일**(`git show <parent>:<oldFile 또는 file>`) 기준이고,
  `after`의 줄 번호는 **커밋 후 파일**(`git show <sha>:<file>`) 기준입니다.
- 커밋 전 파일에서 `before` 줄들을, 커밋 후 파일에서 `after` 줄들을 빼면 남는 줄(바뀌지 않은 줄)은 **순서대로 1:1로 대응**합니다.
  정적 분석 경고를 커밋 전/후 버전끼리 맞춰 볼 때, 바뀌지 않은 줄의 줄 번호가 어떻게 밀렸는지 이걸로 계산할 수 있습니다.
- 바이너리 파일, 내용 변경 없는 이름 변경/권한 변경은 코드 변경이 없으므로 제외됩니다.
- 중간에 취소해도 그때까지 수집한 커밋은 올바른 JSON 배열로 저장되고 열립니다.
- 검색 조건(저장소·키워드)은 파일 이름(`<owner>_<repo>_<키워드>_<날짜-시간>.json`)과 출력 창(`WarnPriority`) 로그에 남습니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `warnPriority.outputDirectory` | `""` | 결과 저장 폴더. 비우면 `<워크스페이스>/warnpriority-output` |
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
  npm run collect -- https://github.com/google/gson "fix,bug" --ext java --out gson.json
  ```

  옵션: `--out <파일>`, `--ext java,py`, `--max N`, `--case-sensitive`, `--regex`, `--merges`, `--ignore-ws`, `--cache <폴더>`(기본 `~/.warnpriority/repos`), `--git <경로>`

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
   ├─ logParser.ts     git log -p 출력 스트리밍 파서 → 추가/삭제/수정 블록
   ├─ writers.ts       결과 JSON 스트리밍 저장 (저장 필드 변환: toOutputCommit)
   ├─ collector.ts     전체 파이프라인
   └─ types.ts         내부 데이터 모델 + 결과 파일 형식(OutputCommit)
l10n/, package.nls*.json   영어/한국어 UI 문자열 (VS Code 표시 언어에 따라 자동 선택)
```
