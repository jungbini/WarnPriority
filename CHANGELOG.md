# Changelog

## 0.13.0

- 규칙별 표 `<결과>.pmd-rules.csv`를 **파일별로** 변경: 여러 파일을 합치지 않고 한 행이 커밋·파일·규칙 하나
  (열: Commit, File, Rule, Ruleset, Priority, Before, After, Removed, Added, Warning Removal Rate).
  **Before가 0인 행은 제외**(`.pmd.json`에는 그대로 남음)

## 0.12.0

- PMD 분석 결과(`.pmd.json`)의 파일마다 **규칙별 `rules`** 추가: 규칙의 `priority`, 수정된 코드 블록의 warning 수 `before`(수정 전)·`after`(수정 후),
  그중 사라진 `removed`·새로 생긴 `added`, 그리고 **`warningRemovalRate` = (before − after) / before**
  (1 = 모두 제거, 0 = 같음, 음수 = 늘어남, before가 0이면 `null`)
- **전체 결과를 규칙별로 합친 표 `<결과>.pmd-rules.csv`** 추가: Rule, Ruleset, Priority, Before, After, Removed, Added,
  Warning Removal Rate(합계로 계산), Files, Commits. 비율이 높은 순으로 정렬. 완료 알림의 **규칙별 표 보기**로 열기
- 완료 알림과 CLI 출력에 전체 파일의 수정된 코드 warning 수(수정 전/후)와 warning removal rate 표시
- `onChangedLine`이 줄이 추가만(또는 삭제만) 된 자리를 감싸는 warning도 `true`로 판정(예: 메서드 중간에 줄이 추가된 경우의 메서드 단위 warning)

## 0.11.0

- 토픽 모델링이 **NVIDIA GPU를 쓰도록** Python 환경 준비 방식 변경: `nvidia-smi`로 GPU와 드라이버의 CUDA 버전을 감지해,
  PyTorch 공식 서버에서 **CUDA 빌드를 먼저 설치**한 뒤 나머지 패키지를 설치(PyPI의 Windows용 PyTorch는 CPU 전용이라 GPU가 있어도 CPU로 실행되던 문제).
  드라이버가 지원하는 빌드 중 가장 새 것부터 시도(cu134 → cu132 → cu130 → cu126 → cu118)
- 이미 만든 환경에 **CPU용 PyTorch가 있으면, 물어본 뒤 먼저 삭제하고** CUDA 빌드로 다시 설치. 실패하면 CPU 빌드를 되돌려 계속 동작
- `warnPriority.topics.pythonPath`로 직접 지정한 Python은 바꾸지 않고, GPU가 있는데 PyTorch가 CPU 빌드면 경고
- 로그에 감지한 GPU·PyTorch 빌드·임베딩 장치를 남기고, 완료 알림에 임베딩을 GPU/CPU 중 어디서 계산했는지 표시

## 0.10.0

- 토픽 모델링에서 **테스트 파일 제외**(`warnPriority.topics.excludeTestFiles`, 기본 켜짐): 테스트 폴더(`test/`, `tests/`, `__tests__/`, `spec/`, `androidTest/` …)나
  테스트 이름 규칙(`*Test.java`, `*IT.java`, `test_*.py`, `*_test.go`, `*.spec.ts`, `*_spec.rb` …)의 파일. CLI: `--include-tests`로 포함
- 어느 토픽에도 속하지 않은 코드는 가장 가까운 토픽에 억지로 넣지 않고 **마지막 `Unclassified`(미분류) 열**로 따로 기록
  (`topic-keywords.csv`에도 마지막 행으로 표시). 이전처럼 넣으려면 스크립트 옵션 `--assign-outliers`
- 완료 알림에 제외한 테스트 파일 수와 미분류 열 안내 표시
- `.vsix`에 Python 캐시 파일(`__pycache__/*.pyc`)이 들어가지 않도록 수정(0.9.0 패키지에 섞여 있었음)

## 0.9.0

- **수정 전 코드 토픽 모델링(BERTopic)**: `WarnPriority: 수정 전 코드 토픽 모델링 (BERTopic)` 명령(탐색기 우클릭, CLI `topics`).
  결과 JSON의 모든 `before/` 파일을 함수 단위 코드 조각으로 나눠 CodeRankEmbed로 임베딩하고, BERTopic(UMAP + HDBSCAN)으로 토픽 수 K를 자동 결정,
  코드 stopword(공통 토큰 + 언어별 예약어 + 영어 기능어)를 뺀 c-TF-IDF로 키워드를 뽑아
  `<결과>.topics.csv`(File Name, Topic #1 (키워드), …, Topic #K — 파일별 토픽 비율 %)와 `<결과>.topic-keywords.csv`로 저장
- 같은 코드 조각은 한 번만 임베딩하고, 임베딩은 결과 폴더의 `.topic-embeddings/`에 캐시(다시 실행하면 새 조각만 계산)
- 처음 사용할 때 동의를 받고 전용 Python 환경을 만들어 패키지 설치(`resources/topics/requirements.txt`), 또는 `warnPriority.topics.pythonPath` 사용.
  설정: `warnPriority.topics.pythonPath`, `.model`, `.minTopicSize`(기본 자동: 서로 다른 조각 수의 약 1%), `.extraStopwords`

## 0.8.0

- PMD 규칙 기본값을 **모든 Java 규칙**으로 변경: `warnPriority.pmd.ruleset` 기본값 `all` =
  카테고리 8개(Best Practices, Code Style, Design, Documentation, Error Prone, Multithreading, Performance, Security)의 전체 규칙.
  확장에 포함된 `resources/pmd/all-java-rules.xml` 사용(설정 없이는 동작하지 않는 `LoosePackageCoupling`만 제외)
- PMD가 설정 문제로 일부 규칙을 실행하지 못해도 분석을 중단하지 않고, 나머지 규칙 결과를 기록하며 알림·로그로 알려 줌
- CLI: `--ruleset` 기본값도 `all`

## 0.7.0

- **PMD 분석**: `WarnPriority: 수집 결과를 PMD로 분석` 명령(수집 완료 알림의 **PMD로 분석** 버튼, 탐색기 우클릭).
  커밋별 수정 전/후 파일에 PMD를 실행해, 사라진 warning(`removed`)과 새로 생긴 warning(`added`), 유지된 warning 수(`unchanged`)를
  `<결과>.pmd.json`에 저장. 바뀌지 않은 줄은 줄 번호 보정, 바뀐 줄은 같은 변경 블록 안에서 같은 규칙끼리 대응
- PMD 7.29.0을 처음 사용할 때 동의를 받고 Maven Central(실패 시 Google 미러)에서 내려받아 SHA-256 검증 후 설치.
  설정: `warnPriority.pmd.ruleset`, `warnPriority.pmd.home`, `warnPriority.pmd.java`
- CLI: `node out/cli.js pmd <result.json>`

## 0.6.0

- 소스 코드가 아닌 파일(XML, README 등)이 결과에 들어가지 않도록 "모든 파일 수집" 모드를 제거:
  `warnPriority.fileExtensions`가 비어 있어도(`[]`) 기본 소스 코드 확장자 목록을 사용.
  다른 확장자는 목록에 직접 넣었을 때만 수집. CLI의 `--ext all`도 제거
- 결과가 없을 때 "키워드를 포함하는 커밋 중 소스 코드 파일을 바꾼 커밋이 없다"고 알려 줌
- 출력 창 로그에 실행 중인 확장 버전(`WarnPriority v<버전>`) 표시
- 그 밖의 동작은 0.5.0과 같음

## 0.5.0

- 정적 분석이 가능한 소스 코드 파일만 기본으로 수집: `warnPriority.fileExtensions` 기본값을
  주요 언어 확장자 목록(`java`, `kt`, `c`, `cpp`, `cs`, `go`, `rs`, `py`, `js`, `ts`, `php`, `rb`, `swift` 등)으로 변경.
  README·XML·YAML·빌드 설정·이미지 등은 제외되고, 그런 파일만 바꾼 커밋은 결과에서 빠짐.
  Java만 수집하려면 `["java"]`, 모든 파일은 `[]`
- 출력 창 로그에 수집 대상 확장자 표시
- CLI: `--ext` 생략 시 같은 기본 목록 사용, `--ext all`로 모든 파일 수집

## 0.4.0

- JSON에서 코드를 빼고 줄 번호만 저장: `{ "type": "modified", "before": [11], "after": [11, 12] }` (블록당 한 줄로 출력)
- 결과를 저장소별 폴더(`<owner>_<repo>/`)에 저장하고, 커밋마다 커밋 해시 폴더를 만들어
  바뀐 파일의 수정 전(`before/`, parent 시점)·수정 후(`after/`, 커밋 시점) 버전을 저장
- 기본 출력 폴더(`<워크스페이스>/warnpriority-output`)에 `.gitignore` 생성
- 서브모듈 포인터 변경(`Subproject commit …`)을 코드 변경에서 제외
- CLI: `--out <파일>` 대신 `--out-dir <폴더>`

## 0.3.0

- `diff`의 각 코드 줄에 줄 번호 추가: `before`/`after`가 `{ "line", "code" }` 배열이 됨
  (`before`는 커밋 전 파일, `after`는 커밋 후 파일 기준). 모든 유형에서 두 배열이 항상 존재
  (`added`/`deleted`의 `code` 필드는 `after`/`before`로 대체)
- 이름이 바뀐 파일에 커밋 전 경로 `oldFile` 추가

## 0.2.0

- 결과 파일을 커밋 배열 JSON으로 단순화: `sha`, `parent`, `author`, `message`, `files[].file`, `files[].diff`만 저장
  (메타데이터·요약·날짜·줄 번호 제거)
- 변경 유형 이름을 `added` / `deleted` / `modified`(추가/삭제/수정)로 변경, 수정은 `before`/`after`로 저장
- 수집이 끝나면 결과 파일을 VS Code 에디터에서 자동으로 열기
- CSV 출력(`warnPriority.outputFormat`) 제거
- 결과 알림이 떠 있는 동안 진행 알림이 닫히지 않던 문제 수정

## 0.1.0

- `WarnPriority: Collect Changed Code from GitHub Commits`: GitHub 주소와 커밋 메시지 키워드를 입력받아,
  일치하는 커밋에서 수정·삽입·삭제된 코드만 JSON/CSV로 저장
- `WarnPriority: Clear Cached Repository Clones`: 캐시된 저장소 복제본 삭제
- 영어/한국어 UI
