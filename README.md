# WarnPriority

GitHub 저장소의 커밋 이력에서 **커밋 메시지에 특정 키워드가 들어간 커밋**을 찾아, 그 커밋에서 **추가·삭제·수정된 줄 번호**를 JSON으로 저장하고, 바뀐 파일의 **수정 전/후 버전**을 커밋별 폴더에 꺼내 두는 VS Code 확장입니다.
수정 전/후 파일에 정적 분석기를 돌린 뒤, JSON의 줄 번호를 기준으로 warning이 어떻게 바뀌었는지 비교하는 데 쓰도록 만들었습니다.

## 설치

[Releases](https://github.com/jungbini/WarnPriority/releases)에서 최신 `warnpriority-<버전>.vsix`를 내려받아,
VS Code 확장(Extensions) 보기 → `···` → **VSIX에서 설치(Install from VSIX...)** 로 설치합니다.
(Git이 설치되어 있어야 합니다.)
새 버전을 설치한 뒤에는 VS Code 창을 다시 로드(명령 팔레트 → `Developer: Reload Window`)해야 새 버전이 실행됩니다.
실행 중인 버전은 출력 창(`WarnPriority`) 로그의 `WarnPriority v<버전>`에서 확인할 수 있습니다.

## 사용법

1. 명령 팔레트(`Ctrl+Shift+P` / `Cmd+Shift+P`)에서 **`WarnPriority: GitHub 커밋에서 변경된 코드 수집`**
   (영문 UI: `WarnPriority: Collect Changed Code from GitHub Commits`)을 실행합니다.
2. **GitHub 주소**를 입력합니다. 예: `https://github.com/google/gson`
3. **커밋 메시지 키워드**를 입력합니다. 예: `fix, bug`
4. 진행 상황이 알림으로 표시되고(취소 가능), 완료되면 결과 파일이 **VS Code 에디터에서 자동으로 열립니다.**

결과는 기본적으로 `<워크스페이스>/warnpriority-output/` 아래, 저장소별 폴더에 저장됩니다(열린 폴더가 없으면 저장할 폴더를 묻습니다).

```
warnpriority-output/
├─ .gitignore                                   ← 결과가 git 변경 목록에 뜨지 않도록 자동 생성
└─ google_gson/                                 ← 저장소(프로젝트)별 폴더
   ├─ google_gson_fix-bug_20261107-104155.json  ← 커밋 목록 + 줄 번호
   ├─ 094f5003ce5f6d2fb65457bee9c78b9d53d25308/ ← 커밋 해시 폴더
   │  ├─ before/gson/src/main/java/com/google/gson/Gson.java   ← 수정 전 (parent 시점)
   │  └─ after/gson/src/main/java/com/google/gson/Gson.java    ← 수정 후 (커밋 시점)
   └─ …
```

- `before/`, `after/` 아래는 저장소 안의 경로를 그대로 따릅니다. 바뀐 파일만 저장합니다(프로젝트 전체가 아님).
- 새로 추가된 파일은 `after/`에만, 삭제된 파일은 `before/`에만 있습니다. 이름이 바뀐 파일은 `before/`에 옛 경로(`oldFile`)로 저장됩니다.
- 같은 저장소를 다른 키워드로 다시 수집하면 같은 커밋 폴더를 그대로 덮어씁니다(내용은 동일).

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

커밋 하나당 항목 하나인 **JSON 배열**입니다. 코드는 저장하지 않고 **줄 번호만** 저장하며, 코드는 위의 `before/`, `after/` 파일에서 확인합니다.

| 필드 | 내용 |
| --- | --- |
| `sha` | 커밋 SHA (= 커밋 폴더 이름) |
| `parent` | 부모 커밋 SHA (diff 비교 기준인 첫 번째 부모, 최초 커밋이면 `null`) |
| `author` | 작성자 `이름 <이메일>` |
| `message` | 커밋 메시지 전체 |
| `files[].file` | 커밋 후 파일 경로 (삭제된 파일은 삭제 전 경로) |
| `files[].oldFile` | 커밋 전 파일 경로 — **이름이 바뀐 파일에만** 있음 |
| `files[].diff` | 추가·삭제·수정된 줄 번호 (아래) |

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
          { "type": "modified", "before": [1118], "after": [1118] },
          { "type": "added", "before": [], "after": [1200, 1201] },
          { "type": "deleted", "before": [1300], "after": [] }
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
| `added` (추가) | 줄이 추가되기만 함 | `[]` | 추가된 줄 번호 |
| `deleted` (삭제) | 줄이 삭제되기만 함 | 삭제된 줄 번호 | `[]` |
| `modified` (수정) | 기존 줄이 삭제되고 그 자리에 다른 줄이 들어감 | 변경 전 줄 번호 | 변경 후 줄 번호 |

- `before` 줄 번호는 `<sha>/before/<oldFile 또는 file>` 파일, `after` 줄 번호는 `<sha>/after/<file>` 파일 기준입니다.
  저장된 파일은 git에 들어 있는 내용 그대로(바이트 단위 동일)라서, 정적 분석기가 보고하는 줄 번호와 바로 비교할 수 있습니다.
- **warning 비교 방법**
  - 수정 전 파일의 warning 중 `before` 줄에 있던 것 → 커밋이 고친(또는 지운) 코드에 있던 warning 후보
  - 수정 후 파일의 warning 중 `after` 줄에 있는 것 → 커밋이 새로 넣은 코드에 생긴 warning 후보
  - 바뀌지 않은 줄의 warning은 위치만 밀립니다: 수정 전 파일에서 `before` 줄을, 수정 후 파일에서 `after` 줄을 빼면
    남는 줄들이 **순서대로 1:1로 대응**하므로, 이걸로 수정 전 줄 번호 ↔ 수정 후 줄 번호를 맞출 수 있습니다.
- 바이너리 파일, 내용 변경 없는 이름 변경/권한 변경, 서브모듈 변경은 코드 변경이 없으므로 제외됩니다.
- 중간에 취소해도 그때까지 수집한 커밋은 올바른 JSON 배열로 저장되고, JSON에 있는 커밋은 모두 커밋 폴더가 있습니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `warnPriority.outputDirectory` | `""` | 결과 저장 폴더(안에 저장소별 폴더 생성). 비우면 `<워크스페이스>/warnpriority-output` |
| `warnPriority.fileExtensions` | 소스 코드 확장자 목록 (아래) | 이 확장자의 파일만 수집. Java만: `["java"]`. 비워 두면 기본 목록 |
| `warnPriority.maxCommits` | `0` | 최대 커밋 수(최신순). `0` = 제한 없음 |
| `warnPriority.caseSensitive` | `false` | 키워드 대소문자 구분 |
| `warnPriority.useRegex` | `false` | 키워드를 정규식(POSIX 확장)으로 처리 |
| `warnPriority.includeMergeCommits` | `false` | 머지 커밋 포함(첫 번째 부모 기준 diff, Git 2.31+) |
| `warnPriority.ignoreWhitespace` | `false` | 공백만 바뀐 변경 무시 |
| `warnPriority.gitPath` | `""` | Git 실행 파일 경로. 비우면 VS Code Git 확장이 쓰는 Git 사용 |


### 수집 대상 파일

정적 분석이 가능한 **소스 코드 파일만** 수집합니다. 기본값은 정적 분석기가 지원하는 언어의 확장자입니다.

`java kt kts scala groovy c h cc cpp cxx hh hpp hxx cs go rs py js jsx mjs cjs ts tsx php rb swift m mm`

README·XML·YAML·빌드 설정·이미지처럼 코드가 아닌 파일은 JSON에도, `before/`·`after/` 폴더에도 들어가지 않습니다.
그런 파일만 바꾼 커밋은 결과에서 빠집니다(google/gson `fix, bug`: 449 → 380 커밋).
분석기가 한 언어만 다룬다면 그 언어로 좁히는 것이 좋습니다. 예를 들어 Java만 수집하려면 설정(`settings.json`)에 다음을 추가합니다.

```json
"warnPriority.fileExtensions": ["java"]
```

설정을 비워 두어도(`[]`) 기본 목록이 적용되므로, XML·README 같은 소스 코드가 아닌 파일은 확장자를 직접 목록에 넣지 않는 한 수집되지 않습니다.
어떤 확장자로 수집했는지는 출력 창(`WarnPriority`) 로그의 `File extensions:` 줄에 남습니다.
## 동작 방식

- GitHub REST API 대신 **`git clone --bare`** 로 저장소를 받아 로컬에서 `git log --grep … -p`로 분석합니다.
  API는 인증 없이 시간당 60회로 제한돼 커밋이 많은 저장소를 분석할 수 없지만, git은 제한 없이 수만 개 커밋도 처리합니다.
- 받은 저장소는 VS Code 확장 저장 공간에 캐시되어, 다음 실행부터는 `git fetch`로 새 커밋만 받습니다.
  디스크를 비우려면 **`WarnPriority: 캐시된 저장소 복제본 삭제`** 명령을 실행하세요.
- 결과는 커밋 단위로 스트리밍 저장되므로 대형 저장소에서도 메모리 사용량이 일정합니다.
  수정 전/후 파일은 `git cat-file --batch` 프로세스 하나로 꺼냅니다(google/gson `fix, bug` + `.java`: 커밋 380개, 파일 3,201개, 약 89MB, 3초 이내).
- 키워드 없이(모든 커밋) 큰 저장소를 수집하면 커밋 폴더가 디스크를 많이 차지할 수 있습니다. `warnPriority.maxCommits`, `warnPriority.fileExtensions`로 범위를 줄이세요.
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
  npm run collect -- https://github.com/google/gson "fix,bug" --ext java --out-dir results
  ```

  옵션: `--out-dir <폴더>`(기본 `./warnpriority-output`, 안에 저장소별 폴더 생성), `--ext java,py`(기본: 위 소스 코드 확장자), `--max N`, `--case-sensitive`, `--regex`, `--merges`, `--ignore-ws`, `--cache <폴더>`(기본 `~/.warnpriority/repos`), `--git <경로>`

- `.vsix` 패키지 만들기: `npm run package` (LICENSE 파일이 없으면 계속할지 묻습니다)
- 릴리스 만들기: `package.json`의 `version`을 올리고 `CHANGELOG.md`에 `## <버전>` 항목을 추가한 뒤,
  GitHub Actions의 **Release** 워크플로를 실행(Run workflow)하거나 `v<버전>` 태그를 푸시합니다.
  워크플로가 테스트 → `.vsix` 빌드 → 릴리스 생성(노트는 CHANGELOG의 해당 버전 항목)까지 처리합니다.

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
   ├─ commitFiles.ts   커밋별 before/after 파일 저장 (경로 안전성 검사 포함)
   ├─ blobReader.ts    git cat-file --batch 로 파일 내용 읽기
   ├─ collector.ts     전체 파이프라인
   └─ types.ts         내부 데이터 모델 + 결과 파일 형식(OutputCommit)
l10n/, package.nls*.json   영어/한국어 UI 문자열 (VS Code 표시 언어에 따라 자동 선택)
```
