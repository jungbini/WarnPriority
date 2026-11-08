# WarnPriority

GitHub 저장소의 커밋 이력에서 정적 분석 warning의 변화를 연구하기 위한 VS Code 확장입니다. 세 단계로 씁니다.

1. **변경 코드 수집** — 커밋 메시지에 키워드(예: `fix, bug`)가 들어간 커밋을 찾아, 바뀐 **줄 번호**를 JSON으로 저장하고 바뀐 소스 파일의 **수정 전/후 버전**을 커밋별 폴더에 꺼내 둡니다.
2. **PMD 분석** — 수정 전/후 파일에 PMD(Java 규칙 전체)를 실행해, 커밋으로 **사라진 warning과 새로 생긴 warning**을 기록하고,
   규칙별로 수정된 코드의 warning 수(수정 전/후)와 **warning removal rate**를 구합니다.
3. **토픽 모델링** — 수정 전 소스 코드 전체를 CodeRankEmbed + BERTopic으로 토픽 모델링해, **파일별 기능(토픽) 비율**을 CSV로 정리합니다.

## 설치

[Releases](https://github.com/jungbini/WarnPriority/releases)에서 최신 `warnpriority-<버전>.vsix`를 내려받아,
VS Code 확장(Extensions) 보기 → `···` → **VSIX에서 설치(Install from VSIX...)** 로 설치합니다.
새 버전을 설치한 뒤에는 VS Code 창을 다시 로드(명령 팔레트 → `Developer: Reload Window`)해야 새 버전이 실행됩니다.
실행 중인 버전은 출력 창(`WarnPriority`) 로그의 `WarnPriority v<버전>`에서 확인할 수 있습니다.

| 기능 | 필요한 것 | 처음 사용할 때 |
| --- | --- | --- |
| 변경 코드 수집 | [Git](https://git-scm.com/) | — |
| PMD 분석 | Java 8 이상 | PMD 7.29.0(약 13 MB)을 내려받을지 묻습니다 |
| 토픽 모델링 | Python 3.9 이상 | 전용 Python 환경에 BERTopic·sentence-transformers·PyTorch(약 1~4 GB)를 설치할지 묻고, 첫 실행 때 CodeRankEmbed 모델(약 550 MB)을 내려받습니다 |

## 사용법

모든 명령은 명령 팔레트(`Ctrl+Shift+P` / `Cmd+Shift+P`)에서 `WarnPriority`를 입력하면 나옵니다.

| 단계 | 명령 (한국어 UI) | 영문 UI | 결과 |
| --- | --- | --- | --- |
| 1 | `GitHub 커밋에서 변경된 코드 수집` | `Collect Changed Code from GitHub Commits` | `<결과>.json` + 커밋별 `before/`·`after/` 폴더 |
| 2 | `수집 결과를 PMD로 분석` | `Analyze Collected Results with PMD` | `<결과>.pmd.json` |
| 3 | `수정 전 코드 토픽 모델링 (BERTopic)` | `Topic Modeling of Before Files (BERTopic)` | `<결과>.topics.csv`, `<결과>.topic-keywords.csv` |
| — | `캐시된 저장소 복제본 삭제` | `Clear Cached Repository Clones` | 내려받아 둔 저장소 삭제 |

### 1. 변경 코드 수집

1. **`WarnPriority: GitHub 커밋에서 변경된 코드 수집`**을 실행합니다.
2. **GitHub 주소**를 입력합니다. 예: `https://github.com/google/gson`
3. **커밋 메시지 키워드**를 입력합니다. 예: `fix, bug` (비워 두면 모든 커밋)
4. 진행 상황이 알림으로 표시되고(취소 가능), 완료되면 결과 JSON이 **에디터에서 자동으로 열립니다.**
   완료 알림의 **PMD로 분석** 버튼을 누르면 바로 2단계로 넘어갑니다.

### 2. PMD로 warning 변화 분석

- 1단계 완료 알림의 **PMD로 분석** 버튼, 또는 **`WarnPriority: 수집 결과를 PMD로 분석`** 실행(결과 JSON 선택), 또는 탐색기에서 결과 JSON 우클릭.
- 결과 `<결과>.pmd.json`이 열립니다. 형식과 비교 기준은 [PMD로 warning 변화 분석](#pmd로-warning-변화-분석)을 보세요.

### 3. 수정 전 코드 토픽 모델링

- **`WarnPriority: 수정 전 코드 토픽 모델링 (BERTopic)`** 실행(결과 JSON 선택), 또는 탐색기에서 결과 JSON 우클릭.
- 결과 `<결과>.topics.csv`가 열리고, 알림의 **키워드 보기**로 토픽별 키워드를 볼 수 있습니다. 자세한 내용은 [수정 전 코드 토픽 모델링](#수정-전-코드-토픽-모델링-bertopic)을 보세요.

### 결과 폴더

결과는 기본적으로 `<워크스페이스>/warnpriority-output/` 아래, 저장소별 폴더에 저장됩니다(열린 폴더가 없으면 저장할 폴더를 묻습니다. 위치는 `warnPriority.outputDirectory`로 바꿀 수 있음).

```
warnpriority-output/
├─ .gitignore                                       ← 결과가 git 변경 목록에 뜨지 않도록 자동 생성
└─ google_gson/                                     ← 저장소(프로젝트)별 폴더
   ├─ google_gson_fix-bug_20261107-104155.json      ← 1단계: 커밋 목록 + 바뀐 줄 번호
   ├─ google_gson_fix-bug_20261107-104155.pmd.json  ← 2단계: 커밋별 사라진/생긴 warning, 파일·규칙별 warning removal rate
   ├─ google_gson_fix-bug_20261107-104155.pmd-rules.csv     ← 2단계: 파일·규칙별 warning removal rate 표
   ├─ google_gson_fix-bug_20261107-104155.topics.csv          ← 3단계: 파일별 토픽 비율(%)
   ├─ google_gson_fix-bug_20261107-104155.topic-keywords.csv  ← 3단계: 토픽별 키워드
   ├─ .topic-embeddings/                            ← 3단계 임베딩 캐시
   ├─ 094f5003ce5f6d2fb65457bee9c78b9d53d25308/     ← 커밋 해시 폴더
   │  ├─ before/gson/src/main/java/com/google/gson/Gson.java   ← 수정 전 (parent 시점)
   │  └─ after/gson/src/main/java/com/google/gson/Gson.java    ← 수정 후 (커밋 시점)
   └─ …
```

- `before/`, `after/` 아래는 저장소 안의 경로를 그대로 따릅니다. 바뀐 소스 파일만 저장합니다(프로젝트 전체가 아님).
- 새로 추가된 파일은 `after/`에만, 삭제된 파일은 `before/`에만 있습니다. 이름이 바뀐 파일은 `before/`에 옛 경로(`oldFile`)로 저장됩니다.
- 같은 저장소를 다른 키워드로 다시 수집하면 같은 커밋 폴더를 그대로 덮어씁니다(내용은 동일).
- 모든 단계는 CLI로도 실행할 수 있습니다([개발](#개발) 참고).

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

## PMD로 warning 변화 분석

수집한 커밋의 수정 전/후 파일에 [PMD](https://pmd.github.io/)를 실행해, 커밋으로 **사라진 warning**과 **새로 생긴 warning**을 기록합니다.
파일마다 **규칙별로 수정된 코드 블록의 warning 수(수정 전/후)와 warning removal rate**도 구합니다.

1. 수집이 끝나면 알림의 **PMD로 분석** 버튼을 누릅니다. 나중에 하려면 명령 팔레트에서 **`WarnPriority: 수집 결과를 PMD로 분석`**을 실행하거나, 탐색기에서 결과 JSON을 우클릭합니다.
2. 처음 한 번은 PMD 7.29.0(Java 분석 모듈, 약 13 MB)을 Maven Central에서 내려받을지 묻습니다.
   jar마다 고정된 SHA-256으로 검증한 뒤 확장 저장 공간에 설치합니다. Maven Central이 응답하지 않으면 Google의 Maven Central 미러를 씁니다.
   이미 설치한 PMD가 있으면 `warnPriority.pmd.home`에 지정합니다.
3. **Java 8 이상**이 필요합니다(`warnPriority.pmd.java` → `JAVA_HOME` → VS Code Java 확장의 JDK → PATH의 `java` 순으로 찾음).
4. 결과는 수집 결과 옆에 `<결과 파일 이름>.pmd.json`으로 저장되고 바로 열립니다.
   파일·규칙별 warning removal rate 표 `<결과 파일 이름>.pmd-rules.csv`도 함께 저장됩니다(완료 알림의 **규칙별 표 보기**, [규칙별 표](#규칙별-표-pmd-rulescsv) 참고).

```json
[
  {
    "sha": "ff521d70b2ecf2ed85dd1012081493ad7d8c0ba6",
    "files": [
      {
        "file": "gson/src/main/java/com/google/gson/internal/TroubleshootingGuide.java",
        "rules": [
          { "rule": "ClassWithOnlyPrivateConstructorsShouldBeFinal", "ruleset": "Design", "priority": 1, "before": 1, "after": 0, "removed": 1, "added": 0, "warningRemovalRate": 1 },
          { "rule": "CommentRequired", "ruleset": "Documentation", "priority": 3, "before": 1, "after": 1, "removed": 0, "added": 0, "warningRemovalRate": 0 }
        ],
        "removed": [
          { "rule": "ClassWithOnlyPrivateConstructorsShouldBeFinal", "ruleset": "Design", "priority": 1, "line": 3, "endLine": 3, "message": "This class has only private constructors and may be final", "onChangedLine": true }
        ],
        "added": [],
        "unchanged": 3
      }
    ]
  }
]
```

| 필드 | 내용 |
| --- | --- |
| `rules` | 규칙별로, 커밋이 **수정한 코드 블록**(`onChangedLine`이 `true`인 위치)에 있던 warning 수. 아래 [warning removal rate](#warning-removal-rate) 참고 |
| `removed` | 커밋 전 파일에 있었는데 커밋 후 사라진 warning (`line`은 **수정 전** 파일 기준) |
| `added` | 커밋 후 새로 생긴 warning (`line`은 **수정 후** 파일 기준) |
| `unchanged` | 커밋 전후 모두 있는 warning 수 |
| `rule` / `ruleset` / `priority` | PMD 규칙 이름 / 카테고리 / 우선순위(1 높음 … 5 낮음) |
| `onChangedLine` | warning이 커밋이 수정한 코드에 있는지: 범위(`line`~`endLine`)에 바뀐 줄이 포함되거나, 줄이 추가만(또는 삭제만) 된 자리를 감싸는 경우(예: 메서드 중간에 줄이 추가됨). 또 **바로 위 줄이 바뀌어 사라지거나 생긴** warning도 포함합니다(사이에 주석·어노테이션 줄만 있는 경우 포함. 예: 메서드 위에 Javadoc이나 `@Override`·`@Test`를 추가, 선언 위의 문장을 삭제). `false`로 사라진 warning은 다른 곳의 변경으로 해결된 경우입니다(예: 안 쓰던 private 메서드를 다른 곳에서 호출하기 시작) |
| `error` | PMD가 수정 전/후 파일을 파싱하지 못해 비교하지 않은 경우의 이유 |

**같은 warning으로 보는 기준**: 같은 규칙의 warning이 대응하는 위치에 있으면 유지된 것으로 봅니다.
바뀌지 않은 줄은 줄 번호가 밀린 만큼 보정하고, 바뀐 줄은 같은 변경 블록 안에서 찾습니다(메시지까지 같은 것을 먼저 대응).
그래도 짝이 없는 warning은 **위치만 옮겨진** 것인지 한 번 더 봅니다.

- 메시지에 따옴표로 된 이름이 있고(변수·메서드·클래스 이름, 문자열 리터럴), 따옴표 밖의 숫자만 다른 메시지가 수정 전과 후에 하나씩만 있으면 같은 warning입니다.
  예: `AvoidDuplicateLiterals`는 리터럴이 처음 나온 줄에 표시되므로, 앞쪽에 같은 리터럴을 쓰면 위치가 옮겨갑니다. 메서드를 파일 안에서 옮긴 경우도 해당합니다.
- 여러 줄에 걸친 warning(클래스, import 목록 등)은 수정 후 위치로 옮긴 범위가 같은 규칙의 warning 하나와 겹치면 같은 warning입니다(예: 맨 위에 import를 추가해 `ExcessiveImports`의 시작 줄이 바뀐 경우).
- `"Public method and constructor comments are required"`처럼 이름이 없는 메시지는 어느 warning인지 구분할 수 없어, 다른 위치끼리 짝짓지 않습니다(사라짐+생김으로 기록).

### warning removal rate

`rules`는 파일의 **수정된 코드 블록**만 보고 규칙별로 warning을 셉니다(바뀌지 않은 줄의 warning은 세지 않음).
바로 위 줄이 바뀌어 사라지거나 생긴 warning(`onChangedLine: true`)도 셉니다. 그 자리에 그대로 남은 warning은 세지 않습니다.

| 필드 | 내용 |
| --- | --- |
| `before` | 수정 전 코드 블록에서 이 규칙을 위반한 warning 수 |
| `after` | 수정 후 코드 블록에서 이 규칙을 위반한 warning 수. 항상 `before − removed + added` |
| `removed` | `before` 중 커밋으로 사라진 warning 수 |
| `added` | `after` 중 커밋으로 새로 생긴 warning 수 |
| `warningRemovalRate` | **(before − after) / before** (소수점 4자리) |

`warningRemovalRate`의 의미:

- `1`: 수정 전에 있던 warning이 모두 사라짐(after = 0)
- `0`~`1`: 줄어듦 (예: 2개 → 1개면 `0.5`)
- `0`: 수정 전과 같은 수
- 음수: 늘어남 (예: 1개 → 3개면 `-2`)
- `null`: 수정 전에 그 규칙의 warning이 없었음(before = 0, 새 파일 포함)

수를 기준으로 하므로, 하나가 사라지고 다른 하나가 생기면(`removed: 1, added: 1`) 비율은 `0`입니다. 이런 경우는 `removed`/`added`로 구분하세요.
여러 파일·커밋을 합쳐 규칙별 비율을 낼 때는 비율을 평균하지 말고 `before`·`after`를 합한 뒤 계산하면 `null`과 작은 표본 문제를 피할 수 있습니다.
완료 알림과 출력 창에는 분석한 모든 파일을 합친 값(수정된 코드의 warning 수정 전/후 개수와 warning removal rate)이 나옵니다.

### 규칙별 표 (`.pmd-rules.csv`)

`.pmd.json`의 파일별 `rules`를 표로 옮긴 것입니다. **한 행이 커밋 하나의 파일 하나의 규칙 하나**이며, 여러 파일을 합치지 않습니다.
수정 전 코드 블록에 그 규칙의 warning이 없었던 경우(**Before = 0**)는 비율을 계산할 수 없으므로 표에서 뺍니다(`.pmd.json`에는 남아 있음).
UTF-8(BOM) CSV라 Excel에서 바로 열립니다. google/gson `fix, bug`(커밋 380개)의 일부:

```csv
Commit,File,Rule,Ruleset,Priority,Before,After,Removed,Added,Warning Removal Rate
dae37cf0fe12235b76fb09f01118a0a8c8823f42,gson/src/main/java/com/google/gson/internal/bind/TypeAdapters.java,LiteralsFirstInComparisons,Best Practices,3,2,2,1,1,0
dae37cf0fe12235b76fb09f01118a0a8c8823f42,gson/src/main/java/com/google/gson/internal/bind/TypeAdapters.java,LocalVariableDeclarationShouldBeAtStartOfBlock,Code Style,3,1,4,1,4,-3
ff521d70b2ecf2ed85dd1012081493ad7d8c0ba6,gson/src/main/java/com/google/gson/internal/Excluder.java,OnlyOneReturn,Code Style,3,6,3,4,1,0.5
ff521d70b2ecf2ed85dd1012081493ad7d8c0ba6,gson/src/main/java/com/google/gson/internal/TroubleshootingGuide.java,ClassWithOnlyPrivateConstructorsShouldBeFinal,Design,1,1,0,1,0,1
ff521d70b2ecf2ed85dd1012081493ad7d8c0ba6,gson/src/main/java/com/google/gson/internal/TroubleshootingGuide.java,CommentRequired,Documentation,3,1,1,0,0,0
```

| 열 | 내용 |
| --- | --- |
| `Commit` / `File` | 커밋 해시 / 파일 경로(수정 후 경로) |
| `Rule` / `Ruleset` / `Priority` | PMD 규칙 이름 / 카테고리 / PMD 우선순위(1 높음 … 5 낮음) |
| `Before` / `After` | 이 파일의 수정된 코드 블록에서 이 규칙을 위반한 warning 수(수정 전 / 수정 후). Before는 항상 1 이상 |
| `Removed` / `Added` | 그중 커밋으로 사라진 / 새로 생긴 warning 수 |
| `Warning Removal Rate` | (Before − After) / Before |

- **순서**: `.pmd.json`과 같습니다(수집 결과의 커밋 순서 → 파일 → 규칙 이름순). 같은 파일이 여러 커밋에서 바뀌었으면 커밋마다 따로 행이 있습니다.
- gson 결과: 2,879행(파일별 규칙 항목 5,696개 중 Before = 0인 2,817개 제외). 비율이 1(모두 제거) 1,000행, 0~1(줄어듦) 150행, 0(같은 수) 1,358행, 음수(늘어남) 371행.
- 여러 파일을 묶어 규칙별 비율을 내려면 비율을 평균하지 말고 Before·After를 합한 뒤 계산하세요. Before가 1~2개뿐인 행은 비율이 1이나 큰 음수로 쉽게 치우칩니다.

참고
- 분석 대상은 바뀐 `.java` 파일뿐이고(프로젝트 전체가 아님), 빌드 없이 실행하므로 클래스패스가 없습니다. 타입 정보가 필요한 일부 PMD 규칙은 정확도가 떨어질 수 있습니다.
- **규칙**: 기본값 `all`은 PMD Java 규칙 카테고리 8개(Best Practices, Code Style, Design, Documentation, Error Prone, Multithreading, Performance, Security)의 **모든 규칙**(약 300개)을 실행합니다.
  확장에 포함된 [`resources/pmd/all-java-rules.xml`](resources/pmd/all-java-rules.xml)을 쓰며, 프로젝트별 설정 없이는 동작하지 않는 `LoosePackageCoupling`(검사할 패키지를 지정해야 함)만 뺐습니다.
  Code Style·Documentation warning이 많이 나오므로(google/gson `fix, bug`: 변화 16,222건 중 약 3/4), 필요하면 `warnPriority.pmd.ruleset`으로 좁히세요.
  예: PMD 권장 세트 `rulesets/java/quickstart.xml`, 카테고리 `category/java/errorprone.xml,category/java/bestpractices.xml`, 또는 직접 만든 XML.
- 설정 문제로 PMD가 실행하지 못한 규칙이 있으면 나머지 규칙으로 분석을 계속하고, 그 사실을 알림과 출력 창 로그에 남깁니다.

## 수정 전 코드 토픽 모델링 (BERTopic)

수집한 커밋들의 **수정 전(before) 소스 코드 전체**를 토픽 모델링해서, 파일마다 어떤 기능(토픽)의 코드가 몇 %인지 정리합니다.

1. 명령 팔레트에서 **`WarnPriority: 수정 전 코드 토픽 모델링 (BERTopic)`**을 실행하거나, 탐색기에서 결과 JSON을 우클릭합니다.
2. 처음 한 번은 WarnPriority 전용 Python 환경을 만들어 BERTopic·sentence-transformers·PyTorch(약 1~4 GB)를 설치할지 묻습니다(Python 3.9 이상 필요).
   **NVIDIA GPU가 있으면 PyTorch의 CUDA 빌드를 설치합니다**([GPU 사용](#gpu-사용) 참고).
   이미 준비된 Python이 있으면 `warnPriority.topics.pythonPath`에 지정합니다(`pip install -r resources/topics/requirements.txt`).
3. 임베딩 모델 [CodeRankEmbed](https://huggingface.co/nomic-ai/CodeRankEmbed)(약 550 MB)는 처음 실행할 때 Hugging Face에서 내려받습니다.
4. 결과는 수집 결과 옆에 저장되고 바로 열립니다.

**`<결과>.topics.csv`** — 파일별 토픽 비율(%). 토픽 수 K는 자동으로 정해지고, 열 제목의 괄호 안은 토픽의 대표 키워드입니다.
어느 토픽에도 속하지 않은 코드는 **마지막 `Unclassified`(미분류) 열**에 들어갑니다(그런 코드가 있을 때만). 한 행의 합은 100%입니다.

google/gson `fix, bug` 전체 380개 커밋에서 테스트 파일을 뺀 수정 전 파일 844개에 실행한 실제 결과입니다(토픽 20개 + 미분류):

```
File Name,Topic #1 (peeked, jj, pos, stack, cur),Topic #2 (variable, resolve, owner, arguments, wildcard),Topic #3 (convenience, elements, element, primitive, member),...,Topic #20 (instead, desired, specified, deserializes, generic),Unclassified
094f5003ce5f6d2fb65457bee9c78b9d53d25308/before/gson/src/main/java/com/google/gson/Gson.java,11.5%,0.0%,0.0%,...,15.0%,37.1%
…
```

**`<결과>.topic-keywords.csv`** — 토픽별 상위 키워드(c-TF-IDF 점수), 코드 조각 수, 코드 줄 수. 마지막 행은 `Unclassified`입니다.

### 처리 과정

1. **파일**: 결과 JSON에 있는 모든 커밋의 `before/` 파일(이름이 바뀐 파일은 옛 경로, 새로 추가된 파일은 제외). `File Name`은 결과 폴더 기준 경로(`<커밋>/before/<파일>`)입니다.
   **테스트 파일은 기본으로 뺍니다**(`warnPriority.topics.excludeTestFiles`). 테스트 폴더(`test/`, `tests/`, `__tests__/`, `spec/`, `androidTest/` 등)에 있거나
   테스트 이름 규칙을 따르는 파일(`*Test.java`, `*Tests.cs`, `*IT.java`, `test_*.py`, `*_test.go`, `*.spec.ts`, `*_spec.rb` 등)이 해당합니다.
   테스트를 넣으면 테스트 예제 데이터(`bag`, `truck`, `sandwiches` 같은 이름)가 따로 토픽을 이룹니다.
2. **코드 조각**: 한 파일에는 여러 기능이 있고 긴 파일은 모델 입력 길이를 넘으므로, 파일을 빈 줄 기준 블록(보통 메서드 하나 + 주석)으로 나눕니다.
   10줄 미만 블록은 다음 블록과 합치고 60줄을 넘는 블록은 자릅니다. 라이선스 머리말과 `import`/`package`/`#include` 줄은 뺍니다(기능이 아니라 의존성이고, 따로 모이면 "import 토픽"이 생기므로).
   같은 파일의 여러 버전에서 바뀌지 않은 조각은 똑같으므로, **같은 조각은 한 번만** 임베딩·클러스터링합니다(자주 바뀐 파일이 토픽을 독차지하지 않도록).
3. **임베딩**: CodeRankEmbed로 조각마다 768차원 벡터를 만듭니다. 결과 폴더의 `.topic-embeddings/`에 캐시되어, 다시 실행하거나 커밋을 더 모은 뒤 실행하면 새 조각만 계산합니다.
4. **토픽**: BERTopic(UMAP + HDBSCAN)이 토픽 수 K를 자동으로 정합니다. 토픽의 최소 크기는 기본으로 서로 다른 코드 조각 수의 약 1%(최소 10)라서,
   저장소 크기와 관계없이 K가 수십 개 이내로 유지됩니다(위 예: 조각 5,280개 → 최소 53 → 토픽 20개. 같은 데이터에서 최소를 10으로 하면 토픽 194개).
   HDBSCAN이 어느 토픽에도 넣지 않은 조각(outlier)은 **`Unclassified`**로 따로 셉니다(위 예: 서로 다른 조각의 15%).
   미분류가 많으면 `warnPriority.topics.minTopicSize`를 줄여 보세요. 미분류 없이 모두 가장 가까운 토픽에 넣으려면 스크립트에 `--assign-outliers`를 줍니다.
5. **키워드(c-TF-IDF)**: 식별자를 단어로 나눈 뒤(`getUserName` → get, user, name) **코드 stopword**를 빼고 계산합니다.
   stopword = 공통 토큰(`return`, `self`, `null`, `get`, `value`, 라이선스 문구 등) + 결과에 있는 언어들의 예약어(Java·Kotlin·Python·JS/TS·C/C++·C#·Go·Rust·Swift·PHP·Ruby 등)
   + 영어 기능어(`that`, `is`, `the` — 주석과 `assertThat`·`isEmpty` 같은 이름에서 나옴). 더 뺄 단어는 `warnPriority.topics.extraStopwords`에 넣습니다.
6. **파일별 비율**: 파일의 코드 줄 중 각 토픽에 속한 조각의 줄 비율입니다(합계 100%).

### GPU 사용

임베딩은 GPU에서 훨씬 빠릅니다. 스크립트는 PyTorch가 GPU를 쓸 수 있으면 자동으로 GPU(fp16)를 씁니다. 그런데 **PyPI의 Windows용 PyTorch는 CPU 전용**이라,
그대로 설치하면 NVIDIA 그래픽카드가 있어도 CPU로 실행됩니다. 그래서 WarnPriority 전용 Python 환경은 이렇게 준비합니다.

1. 실행할 때마다 `nvidia-smi`로 NVIDIA GPU와, 드라이버가 지원하는 CUDA 버전을 확인합니다.
2. GPU가 있으면 PyTorch 공식 서버(`download.pytorch.org`)에서 **CUDA 빌드를 먼저** 설치하고, 그다음 나머지 패키지를 설치합니다(그래야 CPU 빌드로 덮어써지지 않음).
   드라이버가 지원하는 것 중 가장 새 빌드부터 시도합니다(설치하는 Python 버전용이 없으면 다음 것):

   | 빌드 | 필요한 드라이버 CUDA 버전 (`nvidia-smi`의 `CUDA Version`) | PyTorch |
   | --- | --- | --- |
   | cu134 | 13.4 이상 | 2.15 |
   | cu132 | 13.2 이상 | 2.15 |
   | cu130 | 13.0 이상 | 2.14 |
   | cu126 | 12.6 이상 | 2.14 |
   | cu118 | 11.8 이상 | 2.7 |

3. **이미 CPU용 PyTorch가 설치된 환경**(0.10.0 이하에서 만든 환경 등)에서 GPU가 보이면, CPU 빌드를 지우고 CUDA 빌드(약 2~3 GB)로 바꿀지 묻습니다.
   CUDA 빌드를 설치하지 못하면 CPU 빌드를 다시 넣어, 토픽 모델링은 CPU로 계속 동작합니다.
4. `warnPriority.topics.pythonPath`로 **직접 지정한 Python은 건드리지 않습니다.** 그 PyTorch가 CPU 빌드면 경고만 띄웁니다. 직접 바꾸려면(Windows 예):

   ```powershell
   C:\path\to\python.exe -m pip uninstall -y torch
   ```
   ```powershell
   C:\path\to\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu132
   ```

**GPU를 쓰는지 확인**: 출력 창(`WarnPriority`) 로그에 다음 줄이 보이면 됩니다. 완료 알림에도 임베딩을 GPU/CPU 중 어디서 계산했는지 나옵니다.

```
NVIDIA GPU: NVIDIA GeForce RTX 3070 Ti (driver supports CUDA 13.2)
PyTorch 2.15.0+cu132 (CUDA 13.2), GPU available: True
Embedding model nomic-ai/CodeRankEmbed on cuda:0
```

`GPU available: False`로 나오면 NVIDIA 드라이버를 업데이트하세요. WSL이나 원격(Remote) 환경에서 VS Code를 쓰면, 확장은 그쪽에서 실행되므로 그 환경에서 GPU가 보여야 합니다.

- 이미 토픽 모델링한 결과 JSON은 저장해 둔 임베딩(`.topic-embeddings/`)을 다시 쓰므로 임베딩을 계산하지 않고, 위 두·세 번째 줄과 완료 알림의 GPU/CPU 표시도 나오지 않습니다.
  GPU로 다시 계산하려면 그 폴더를 지우고 실행하세요.
- Linux에서는 cu126 이상 빌드가 CUDA 라이브러리를 `pypi.nvidia.com`에서 함께 받으므로 그 주소에 접속할 수 있어야 합니다(Windows 빌드는 CUDA 라이브러리가 휠 하나에 들어 있어 필요 없음).

### 걸리는 시간
임베딩 계산량은 코드 양에 비례합니다. **GPU(CUDA)나 Apple Silicon(MPS)이 있으면 자동으로 사용**하며 훨씬 빠릅니다.
CPU만 쓰면 오래 걸립니다. 4코어 CPU에서 측정한 값:

| 대상 | 서로 다른 코드 조각 | 첫 실행 | 다시 실행(임베딩 캐시 사용) |
| --- | --- | --- | --- |
| google/gson `fix, bug` 중 최근 60개 커밋(수정 전 파일 373개) | 약 3,400개 | 약 16분 | 약 30초 |
| google/gson `fix, bug` 전체 380개 커밋, 테스트 포함(수정 전 파일 1,587개) | 10,848개 | 새 조각 7,609개 계산에 약 37분 | — |
| google/gson `fix, bug` 전체 380개 커밋, 테스트 제외(기본, 수정 전 파일 844개) | 5,280개 | — | 약 1분 |

CPU에서는 대략 서로 다른 코드 조각 3,400개에 16분 정도이므로, 수집한 커밋이 많으면 그에 비례해 늘어납니다(시작할 때 출력 창 로그에 조각 수가 나옵니다).
진행 상황은 알림에 표시되고 언제든 취소할 수 있으며, 그때까지 계산한 임베딩은 캐시에 남아 다음 실행에 이어서 씁니다.

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
| `warnPriority.pmd.ruleset` | `all` | 실행할 PMD 규칙. `all`: Java 규칙 전부. 또는 세트·카테고리·XML 경로(쉼표 구분) |
| `warnPriority.pmd.home` | `""` | 이미 설치한 PMD 7 폴더(`lib/` 포함). 비우면 자동으로 내려받은 PMD 사용 |
| `warnPriority.pmd.java` | `""` | PMD를 실행할 Java 실행 파일 |
| `warnPriority.topics.pythonPath` | `""` | 토픽 모델링용 Python. 비우면 전용 환경을 만들어 사용 |
| `warnPriority.topics.model` | `nomic-ai/CodeRankEmbed` | 임베딩 모델 |
| `warnPriority.topics.minTopicSize` | `0` (자동) | 토픽 최소 크기(코드 조각 수). `0`: 서로 다른 조각 수의 약 1%. 크게 하면 토픽 수 K가 줄어듦 |
| `warnPriority.topics.extraStopwords` | `[]` | 토픽 키워드에서 추가로 뺄 단어 |
| `warnPriority.topics.excludeTestFiles` | `true` | 테스트 파일은 토픽 모델링에서 뺌 |
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

- PMD 분석도 CLI로 실행할 수 있습니다(PMD는 `~/.warnpriority/pmd`에 내려받음):

  ```bash
  npm run collect -- pmd results/google_gson/google_gson_fix-bug_20261107-104155.json --ruleset category/java/errorprone.xml
  ```

  옵션: `--ruleset <규칙>`, `--pmd-home <PMD 폴더>`, `--java <java 경로>`
- 토픽 모델링도 CLI로 실행할 수 있습니다(Python에 `resources/topics/requirements.txt` 설치 필요):

  ```bash
  npm run collect -- topics results/google_gson/google_gson_fix-bug_20261107-104155.json --python python3
  ```

  옵션: `--python <경로>`, `--model <모델>`, `--min-topic-size N`, `--extra-stopwords a,b`, `--include-tests`(테스트 파일도 포함).
  스크립트를 직접 쓸 수도 있습니다: `python resources/topics/topic_model.py <result.json> --help`
- 실제 PMD로 도는 테스트까지 실행하려면: `WARNPRIORITY_PMD_HOME=<PMD 폴더> npm test` (없으면 그 테스트만 건너뜀)
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
   ├─ pmdArtifacts.ts  PMD jar 목록(버전·SHA-256 고정)
   ├─ pmdInstaller.ts  PMD 내려받기·검증·설치
   ├─ pmdRunner.ts     PMD 실행, JSON 리포트 읽기 (ruleset "all" → resources/pmd/all-java-rules.xml)
   ├─ warningDiff.ts   커밋 전후 warning 대응, 규칙별 수정된 코드 warning 수·warning removal rate(분석기와 무관)
   ├─ ruleTable.ts     파일·규칙별 표(Before 0 제외) → <결과>.pmd-rules.csv
   ├─ analyzeWithPmd.ts PMD 분석 전체 흐름 → <결과>.pmd.json, <결과>.pmd-rules.csv
   ├─ topics.ts        토픽 모델링 스크립트 실행, 전용 Python 환경 준비
   ├─ collector.ts     전체 파이프라인
   └─ types.ts         내부 데이터 모델 + 결과 파일 형식(OutputCommit)
resources/topics/       topic_model.py(BERTopic 파이프라인), requirements.txt
l10n/, package.nls*.json   영어/한국어 UI 문자열 (VS Code 표시 언어에 따라 자동 선택)
```
