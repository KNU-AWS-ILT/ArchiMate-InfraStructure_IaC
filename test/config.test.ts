import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App } from 'aws-cdk-lib';
import { WEB_PLACEHOLDER_PATH, loadConfig, resourceName } from '../lib/config';

describe('resourceName', () => {
  it('archimate-{env}-{서비스}-{용도} 형태로 조합한다', () => {
    expect(resourceName('demo', 'dynamodb', 'designs')).toBe('archimate-demo-dynamodb-designs');
  });

  it('허용되지 않는 문자는 거부한다', () => {
    expect(() => resourceName('demo', 'Lambda', 'generate')).toThrow();
  });
});

describe('loadConfig', () => {
  it('기본 스테이지는 demo, 리전은 서울이다', () => {
    const config = loadConfig(new App());
    expect(config.stage).toBe('demo');
    expect(config.region).toBe('ap-southeast-2');
    expect(config.monthlyBudgetUsd).toBe(30);
  });

  it('잘못된 스테이지 이름은 거부한다', () => {
    const app = new App({ context: { stage: 'Prod_1' } });
    expect(() => loadConfig(app)).toThrow();
  });

  it('LLM 제공자 기본값은 bedrock이다', () => {
    expect(loadConfig(new App()).llmProvider).toBe('bedrock');
  });

  it('-c llmProvider=mock으로 바꿀 수 있다', () => {
    expect(loadConfig(new App({ context: { llmProvider: 'mock' } })).llmProvider).toBe('mock');
  });

  it('llmProvider에 bedrock·mock 외의 값은 거부한다', () => {
    expect(() => loadConfig(new App({ context: { llmProvider: 'gemini' } }))).toThrow();
  });

  it('Bedrock 모델 ID는 리전 접두사 없는 ID 하나뿐이다 (백엔드 #15 syd348 정정)', () => {
    const config = loadConfig(new App());
    expect(config.bedrockModelIds).toEqual({
      design: 'anthropic.claude-opus-5-5',
      explain: 'anthropic.claude-haiku-5-5',
    });
    // 추론 프로필 ID와 파운데이션 모델 ID를 따로 두지 않는다.
    expect(Object.keys(config).filter((key) => /foundation|inferenceProfile/i.test(key))).toEqual([]);
  });

  describe('Cognito 도메인 접두사(cognitoDomainPrefix)', () => {
    const load = (cognitoDomainPrefix?: string, stage?: string) =>
      loadConfig(new App({ context: { ...(cognitoDomainPrefix ? { cognitoDomainPrefix } : {}), ...(stage ? { stage } : {}) } }));

    it('기본값은 archimate-demo-knu다', () => {
      expect(load().cognitoDomainPrefix).toBe('archimate-demo-knu');
    });

    it('기본값은 스테이지를 따라간다', () => {
      expect(load(undefined, 'test').cognitoDomainPrefix).toBe('archimate-test-knu');
    });

    it('-c cognitoDomainPrefix로 바꿀 수 있다', () => {
      expect(load('archimate-team4-web').cognitoDomainPrefix).toBe('archimate-team4-web');
    });

    it.each([
      ['대문자', 'Archimate-demo'],
      ['밑줄', 'archimate_demo'],
      ['점', 'archimate.demo'],
      ['하이픈으로 시작', '-archimate'],
      ['하이픈으로 끝남', 'archimate-'],
      ['64자 이상', 'a'.repeat(64)],
    ])('형식에 맞지 않으면 거부한다: %s', (_label, prefix) => {
      expect(() => load(prefix)).toThrow(/cognitoDomainPrefix/);
    });

    it('63자까지는 허용한다', () => {
      expect(load('a'.repeat(63)).cognitoDomainPrefix).toHaveLength(63);
    });

    it.each(['my-aws-app', 'amazon-login', 'cognito-demo', 'xxcognitoxx'])(
      'aws·amazon·cognito가 들어간 접두사는 거부한다: %s',
      (prefix) => {
        expect(() => load(prefix)).toThrow(/aws·amazon·cognito/);
      },
    );

    it('스테이지 이름에 금지 단어가 있어 기본 접두사가 걸리면, 바꾸라는 안내와 함께 거부한다', () => {
      expect(() => load(undefined, 'aws-test')).toThrow(/-c cognitoDomainPrefix/);
    });
  });

  it('Lambda 코드는 기본으로 더미(lambda-stub)를 쓴다', () => {
    const config = loadConfig(new App());
    expect(config.lambdaCodeSource).toBe('stub');
    expect(config.lambdaCodePath).toMatch(/lambda-stub$/);
  });

  it('-c lambdaCode=backend이면 백엔드 레포의 build/lambda 번들을 쓴다', () => {
    const config = loadConfig(new App({ context: { lambdaCode: 'backend', backendPath: '../ArchiMate-Backend' } }));
    expect(config.lambdaCodeSource).toBe('backend');
    expect(config.lambdaCodePath).toMatch(/ArchiMate-Backend[\\/]build[\\/]lambda$/);
  });

  it('lambdaCode에 stub·backend 외의 값은 거부한다', () => {
    expect(() => loadConfig(new App({ context: { lambdaCode: 'zip' } }))).toThrow();
  });

  describe('프론트 업로드 경로(webSourcePath)', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimate-web-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('webAssetPath 폴더가 없으면 플레이스홀더를 올린다', () => {
      const config = loadConfig(new App({ context: { webAssetPath: path.join(tempDir, 'missing') } }));
      expect(config.webSourcePath).toBe(WEB_PLACEHOLDER_PATH);
    });

    it('폴더는 있어도 index.html이 없으면 플레이스홀더를 올린다', () => {
      const config = loadConfig(new App({ context: { webAssetPath: tempDir } }));
      expect(config.webSourcePath).toBe(WEB_PLACEHOLDER_PATH);
    });

    it('index.html이 있으면 webAssetPath를 올린다', () => {
      fs.writeFileSync(path.join(tempDir, 'index.html'), '<html></html>');
      const config = loadConfig(new App({ context: { webAssetPath: tempDir } }));
      expect(config.webSourcePath).toBe(tempDir);
    });

    it('플레이스홀더 폴더에는 index.html이 있다', () => {
      expect(fs.existsSync(path.join(WEB_PLACEHOLDER_PATH, 'index.html'))).toBe(true);
    });
  });
});
