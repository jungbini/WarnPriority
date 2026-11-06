# Changelog

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
