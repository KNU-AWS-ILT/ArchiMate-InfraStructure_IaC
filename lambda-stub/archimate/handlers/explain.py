"""더미 핸들러. 백엔드 코드가 main에 올라오기 전까지 CDK 합성·테스트용으로만 쓴다.

실제 코드는 ArchiMate-Backend `src/archimate/handlers/explain.py`다.
"""


def handler(event, context):
    return {"statusCode": 200}
