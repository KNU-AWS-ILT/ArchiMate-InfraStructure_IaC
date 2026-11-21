"""더미 핸들러. 백엔드 코드가 main에 올라오기 전까지 CDK 합성·테스트용으로만 쓴다.

실제 코드는 ArchiMate-Backend `src/archimate/handlers/generate.py`다.
`-c lambdaCode=backend`로 바꾸면 이 폴더 대신 백엔드 코드를 묶는다.
"""


def handler(event, context):
    return {"statusCode": 200}
