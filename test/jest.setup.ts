/**
 * 모든 테스트 파일이 시작하기 전에 실행된다. (jest.config.js의 setupFiles)
 *
 * 테스트는 스택을 수십 번 합성하는데, 그때마다 CDK가 자산(Lambda 코드, S3에 올릴 파일, 업로드용 layer)을
 * 임시 폴더로 복사한다. 테스트는 자산 파일을 검사하지 않으므로 복사를 끈다.
 * 효과: 실행 시간이 절반 가까이 줄고, 임시 폴더에 쌓이는 용량이 크게 준다.
 * 실제 `cdk synth`와 배포에는 영향이 없다. (이 설정은 테스트 프로세스에만 적용된다)
 *
 * 이미 CDK_CONTEXT_JSON이 있으면 그 값을 살리고 이 키만 더한다.
 */
const existing = process.env.CDK_CONTEXT_JSON ? JSON.parse(process.env.CDK_CONTEXT_JSON) : {};
process.env.CDK_CONTEXT_JSON = JSON.stringify({ ...existing, 'aws:cdk:disable-asset-staging': true });

export {};
