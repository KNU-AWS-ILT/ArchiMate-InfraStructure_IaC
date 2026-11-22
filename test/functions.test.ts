import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ArchimateStack } from '../lib/archimate-stack';
import { loadConfig } from '../lib/config';

function synth(context?: Record<string, string>): Template {
  const app = new App({ context });
  const stack = new ArchimateStack(app, 'archimate-demo', { config: loadConfig(app) });
  return Template.fromStack(stack);
}

const template = synth();
const json = template.toJSON();

const GENERATE = 'archimate-demo-lambda-generate';
const EXPLAIN = 'archimate-demo-lambda-explain';
const SYNC_PRICES = 'archimate-demo-lambda-sync-prices';

type Json = Record<string, any>;

function functionByName(name: string): { id: string; resource: Json } {
  const found = Object.entries(template.findResources('AWS::Lambda::Function')).filter(
    ([, r]) => (r as Json).Properties.FunctionName === name,
  );
  expect(found).toHaveLength(1);
  return { id: found[0][0], resource: found[0][1] as Json };
}

function tableLogicalId(tableName: string): string {
  const found = Object.keys(template.findResources('AWS::DynamoDB::Table', { Properties: { TableName: tableName } }));
  expect(found).toHaveLength(1);
  return found[0];
}

/** 함수 실행 역할에 붙은 IAM 문장 전체 */
function statementsOf(functionName: string): Json[] {
  const roleId = functionByName(functionName).resource.Properties.Role['Fn::GetAtt'][0];
  const policies = Object.values(json.Resources as Json).filter(
    (r: Json) =>
      r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((role: Json) => role.Ref === roleId),
  );
  return policies.flatMap((p: Json) => p.Properties.PolicyDocument.Statement as Json[]);
}

const asList = (value: unknown): string[] => (Array.isArray(value) ? value : [value]) as string[];

/** 테이블별 접근 종류: 읽기(GetItem), 쓰기(PutItem) */
function tableAccess(functionName: string): Record<string, string> {
  const tables = {
    designs: tableLogicalId('archimate-demo-dynamodb-designs'),
    prices: tableLogicalId('archimate-demo-dynamodb-prices'),
    explanations: tableLogicalId('archimate-demo-dynamodb-explanations'),
  };
  const result: Record<string, string> = {};
  for (const [name, logicalId] of Object.entries(tables)) {
    const kinds = new Set<string>();
    for (const statement of statementsOf(functionName)) {
      const actions = asList(statement.Action);
      if (!actions.some((a) => a.startsWith('dynamodb:'))) continue;
      if (!JSON.stringify(statement.Resource).includes(`"${logicalId}"`)) continue;
      if (actions.includes('dynamodb:GetItem')) kinds.add('read');
      if (actions.includes('dynamodb:PutItem')) kinds.add('write');
    }
    result[name] = kinds.size === 0 ? 'none' : [...kinds].sort().join('+');
  }
  return result;
}

function statementsWithAction(functionName: string, prefix: string): Json[] {
  return statementsOf(functionName).filter((s) => asList(s.Action).some((a) => a.startsWith(prefix)));
}

describe('Lambda 3개 공통 설정', () => {
  // S3 자동 삭제·파일 업로드용 도우미 Lambda(CDK가 만듦)는 이름이 없어서 제외하고, 우리가 만든 함수만 본다.
  const ourFunctions = (): Json[] =>
    (Object.values(template.findResources('AWS::Lambda::Function')) as Json[]).filter(
      (r) => r.Properties.FunctionName,
    );

  it('함수는 3개이고 이름은 resourceName 규칙이다', () => {
    expect(ourFunctions().map((r) => r.Properties.FunctionName).sort()).toEqual(
      [EXPLAIN, GENERATE, SYNC_PRICES].sort(),
    );
    for (const name of [GENERATE, EXPLAIN, SYNC_PRICES]) {
      expect(functionByName(name)).toBeDefined();
    }
  });

  it('Python 3.12, ARM64이다', () => {
    expect(ourFunctions()).toHaveLength(3);
    for (const fn of ourFunctions()) {
      expect(fn.Properties.Runtime).toBe('python3.12');
      expect(fn.Properties.Architectures).toEqual(['arm64']);
    }
  });

  it('진입 함수는 백엔드 #15 확정 경로다', () => {
    expect(functionByName(GENERATE).resource.Properties.Handler).toBe('archimate.handlers.generate.handler');
    expect(functionByName(EXPLAIN).resource.Properties.Handler).toBe('archimate.handlers.explain.handler');
    expect(functionByName(SYNC_PRICES).resource.Properties.Handler).toBe(
      'archimate.handlers.sync_prices.handler',
    );
  });

  it('로그 보존 2주(14일), 삭제 정책 DESTROY', () => {
    const named = (Object.values(template.findResources('AWS::Logs::LogGroup')) as Json[]).filter(
      (g) => typeof g.Properties.LogGroupName === 'string' && g.Properties.LogGroupName.startsWith('/aws/lambda/archimate-'),
    );
    expect(named).toHaveLength(3);
    for (const name of [GENERATE, EXPLAIN, SYNC_PRICES]) {
      const groups = Object.values(
        template.findResources('AWS::Logs::LogGroup', { Properties: { LogGroupName: `/aws/lambda/${name}` } }),
      ) as Json[];
      expect(groups).toHaveLength(1);
      expect(groups[0].Properties.RetentionInDays).toBe(14);
      expect(groups[0].DeletionPolicy).toBe('Delete');
    }
  });

  it('태그 3종이 붙는다', () => {
    expect(ourFunctions()).toHaveLength(3);
    for (const fn of ourFunctions()) {
      expect(fn.Properties.Tags).toEqual(
        expect.arrayContaining([
          { Key: 'Environment', Value: 'demo' },
          { Key: 'Owner', Value: 'infra' },
          { Key: 'Project', Value: 'ArchiMate' },
        ]),
      );
    }
  });

  it('스테이지를 바꾸면 이름이 따라간다', () => {
    synth({ stage: 'test' }).hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'archimate-test-lambda-generate',
    });
  });
});

describe('제한 시간', () => {
  it('generate 180초', () => {
    expect(functionByName(GENERATE).resource.Properties.Timeout).toBe(180);
  });

  it('explain 25초', () => {
    expect(functionByName(EXPLAIN).resource.Properties.Timeout).toBe(25);
  });

  it('sync_prices 300초 (명세 없음, 임시값)', () => {
    expect(functionByName(SYNC_PRICES).resource.Properties.Timeout).toBe(300);
  });
});

describe('환경 변수', () => {
  const variables = (name: string): Json => functionByName(name).resource.Properties.Environment.Variables;

  it('explain에 LLM_EXPLAIN_MODEL이 있다 (접두사 없는 모델 ID, 백엔드 #15 syd348 정정)', () => {
    expect(variables(EXPLAIN).LLM_EXPLAIN_MODEL).toBe('anthropic.claude-haiku-5-5');
  });

  it('각 Lambda에는 필요한 환경 변수만 있다', () => {
    // generate의 EXPLANATIONS_TABLE은 백엔드 storage/dynamodb.py가 시작할 때 읽어서 넣는다. (권한은 아래 권한표에서 없음을 확인)
    expect(Object.keys(variables(GENERATE)).sort()).toEqual(
      ['DESIGNS_TABLE', 'EXPLANATIONS_TABLE', 'LLM_MODEL', 'LLM_PROVIDER', 'PRICES_TABLE'].sort(),
    );
    expect(Object.keys(variables(EXPLAIN)).sort()).toEqual(
      ['DESIGNS_TABLE', 'EXPLANATIONS_TABLE', 'LLM_EXPLAIN_MODEL', 'LLM_PROVIDER'].sort(),
    );
    expect(Object.keys(variables(SYNC_PRICES))).toEqual(['PRICES_TABLE']);
  });

  it('테이블 이름 변수는 해당 테이블을 가리킨다', () => {
    const designs = tableLogicalId('archimate-demo-dynamodb-designs');
    const prices = tableLogicalId('archimate-demo-dynamodb-prices');
    const explanations = tableLogicalId('archimate-demo-dynamodb-explanations');
    expect(variables(GENERATE).DESIGNS_TABLE).toEqual({ Ref: designs });
    expect(variables(GENERATE).PRICES_TABLE).toEqual({ Ref: prices });
    expect(variables(GENERATE).EXPLANATIONS_TABLE).toEqual({ Ref: explanations });
    expect(variables(EXPLAIN).DESIGNS_TABLE).toEqual({ Ref: designs });
    expect(variables(EXPLAIN).EXPLANATIONS_TABLE).toEqual({ Ref: explanations });
    expect(variables(SYNC_PRICES).PRICES_TABLE).toEqual({ Ref: prices });
  });

  it('LLM_PROVIDER 기본값은 bedrock, LLM_MODEL은 접두사 없는 모델 ID다 (백엔드 #15 syd348 정정)', () => {
    expect(variables(GENERATE).LLM_PROVIDER).toBe('bedrock');
    expect(variables(GENERATE).LLM_MODEL).toBe('anthropic.claude-opus-5-5');
    expect(variables(EXPLAIN).LLM_PROVIDER).toBe('bedrock');
  });

  it('모델 ID에 global. 같은 리전 접두사가 없다 (서울은 Global 엔드포인트)', () => {
    expect(variables(GENERATE).LLM_MODEL).toMatch(/^anthropic\./);
    expect(variables(EXPLAIN).LLM_EXPLAIN_MODEL).toMatch(/^anthropic\./);
  });

  it('-c llmProvider=mock으로 바꾸면 generate·explain의 LLM_PROVIDER가 mock이다', () => {
    const mock = synth({ llmProvider: 'mock' });
    for (const name of [GENERATE, EXPLAIN]) {
      const found = Object.values(mock.findResources('AWS::Lambda::Function', { Properties: { FunctionName: name } }));
      expect((found[0] as Json).Properties.Environment.Variables.LLM_PROVIDER).toBe('mock');
    }
    // 모델 ID는 그대로다
    const generate = Object.values(
      mock.findResources('AWS::Lambda::Function', { Properties: { FunctionName: GENERATE } }),
    )[0] as Json;
    expect(generate.Properties.Environment.Variables.LLM_MODEL).toBe('anthropic.claude-opus-5-5');
  });

  it('기한 환경 변수(LLM_GENERATION_DEADLINE_S 등)는 넣지 않는다 (백엔드 기본값 사용)', () => {
    for (const name of [GENERATE, EXPLAIN, SYNC_PRICES]) {
      expect(Object.keys(variables(name)).filter((key) => /DEADLINE|TIMEOUT/.test(key))).toEqual([]);
    }
  });
});

describe('자기 자신 호출 권한', () => {
  it('generate만 자기 ARN에 lambda:InvokeFunction 권한이 있다', () => {
    const invoke = statementsWithAction(GENERATE, 'lambda:');
    expect(invoke).toHaveLength(1);
    expect(asList(invoke[0].Action)).toEqual(['lambda:InvokeFunction']);
    expect(JSON.stringify(invoke[0].Resource)).toContain(`:function:${GENERATE}`);
  });

  it('explain과 sync_prices에는 lambda 호출 권한이 없다', () => {
    expect(statementsWithAction(EXPLAIN, 'lambda:')).toHaveLength(0);
    expect(statementsWithAction(SYNC_PRICES, 'lambda:')).toHaveLength(0);
  });
});

describe('비동기 호출 재시도', () => {
  const configs = (): Json[] => Object.values(template.findResources('AWS::Lambda::EventInvokeConfig')) as Json[];

  it('generate의 재시도 횟수는 0이다 (LLM 호출 중복 방지)', () => {
    const generateId = functionByName(GENERATE).id;
    const forGenerate = configs().filter((c) => c.Properties.FunctionName.Ref === generateId);
    expect(forGenerate).toHaveLength(1);
    expect(forGenerate[0].Properties.MaximumRetryAttempts).toBe(0);
    expect(forGenerate[0].Properties.Qualifier).toBe('$LATEST');
  });

  it('비동기 호출 설정은 generate에만 있다', () => {
    template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 1);
  });
});

describe('테이블 권한표', () => {
  it('generate: designs 읽기·쓰기, prices 읽기, explanations 없음 (환경 변수에 이름이 있어도 권한은 없다, 백엔드 #15)', () => {
    expect(tableAccess(GENERATE)).toEqual({ designs: 'read+write', prices: 'read', explanations: 'none' });
  });

  it('explain: designs 읽기, explanations 읽기·쓰기, prices 없음', () => {
    expect(tableAccess(EXPLAIN)).toEqual({ designs: 'read', prices: 'none', explanations: 'read+write' });
  });

  it('sync_prices: prices 쓰기만', () => {
    expect(tableAccess(SYNC_PRICES)).toEqual({ designs: 'none', prices: 'write', explanations: 'none' });
  });
});

/**
 * Bedrock 계열 권한 문장 전부. 접두사 `bedrock`은 `bedrock:`(runtime)과 `bedrock-mantle:`을 모두 잡는다.
 * (`bedrock:`만 찾으면 `bedrock-mantle:` 권한을 놓쳐, "권한 없음" 검사가 빈 검사가 된다)
 */
const bedrockStatements = (functionName: string): Json[] => statementsWithAction(functionName, 'bedrock');

describe('Bedrock·Price List 권한', () => {
  // 백엔드 #15 syd348 정정: bedrock-mantle Messages API → `bedrock-mantle:CreateInference` 하나만 허용한다.
  // 모델 리소스 ARN 형식이 문서에 없어 리소스는 '*'다. 형식을 확인해 두 모델로 좁히면 이 검사도 함께 바꾼다.
  it.each([
    ['generate', GENERATE],
    ['explain', EXPLAIN],
  ])('%s: bedrock-mantle:CreateInference 하나만 허용한다 (리소스 *는 임시, 실배포 전 확인)', (_label, name) => {
    const bedrock = bedrockStatements(name);
    expect(bedrock).toHaveLength(1);
    expect(asList(bedrock[0].Action)).toEqual(['bedrock-mantle:CreateInference']);
    expect(bedrock[0].Resource).toBe('*');
    expect(bedrock[0].Effect).toBe('Allow');
  });

  it('InvokeModel 계열(bedrock:)과 추론 프로필·파운데이션 모델 ARN은 어디에도 없다', () => {
    const text = JSON.stringify(json);
    expect(text).not.toContain('bedrock:InvokeModel');
    expect(text).not.toContain('inference-profile');
    expect(text).not.toContain('foundation-model');
    for (const name of [GENERATE, EXPLAIN, SYNC_PRICES]) {
      const actions = bedrockStatements(name).flatMap((s) => asList(s.Action));
      expect(actions.filter((a) => a.startsWith('bedrock:'))).toEqual([]);
    }
  });

  it('sync_prices에는 Bedrock 계열 권한이 없다 (bedrock-mantle 포함)', () => {
    expect(bedrockStatements(SYNC_PRICES)).toHaveLength(0);
  });

  it('Price List API 권한은 sync_prices에만 있다', () => {
    const pricing = statementsWithAction(SYNC_PRICES, 'pricing:');
    expect(pricing).toHaveLength(1);
    expect(asList(pricing[0].Action)).toContain('pricing:GetProducts');
    expect(statementsWithAction(GENERATE, 'pricing:')).toHaveLength(0);
    expect(statementsWithAction(EXPLAIN, 'pricing:')).toHaveLength(0);
  });
});
