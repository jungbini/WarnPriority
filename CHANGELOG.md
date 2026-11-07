# Changelog

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
