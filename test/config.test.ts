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
    expect(config.region).toBe('ap-northeast-2');
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

  it('Bedrock 모델 ID는 추론 프로필과 파운데이션 모델이 짝을 이룬다 (백엔드 #15·#22)', () => {
    const config = loadConfig(new App());
    expect(config.bedrockModelIds).toEqual({
      design: 'global.anthropic.claude-opus-5-5',
      explain: 'global.anthropic.claude-haiku-5-5',
    });
    expect(config.bedrockFoundationModelIds).toEqual({
      design: 'anthropic.claude-opus-5-5',
      explain: 'anthropic.claude-haiku-5-5',
    });
    expect(config.bedrockModelIds.design).toBe(`global.${config.bedrockFoundationModelIds.design}`);
    expect(config.bedrockModelIds.explain).toBe(`global.${config.bedrockFoundationModelIds.explain}`);
  });

  it('Lambda 코드는 기본으로 더미(lambda-stub)를 쓴다', () => {
    const config = loadConfig(new App());
    expect(config.lambdaCodeSource).toBe('stub');
    expect(config.lambdaCodePath).toMatch(/lambda-stub$/);
  });

  it('-c lambdaCode=backend이면 백엔드 레포의 src를 쓴다', () => {
    const config = loadConfig(new App({ context: { lambdaCode: 'backend', backendPath: '../ArchiMate-Backend' } }));
    expect(config.lambdaCodeSource).toBe('backend');
    expect(config.lambdaCodePath).toMatch(/ArchiMate-Backend[\\/]src$/);
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
