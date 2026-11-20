import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ArchimateStack } from '../lib/archimate-stack';
import { loadConfig } from '../lib/config';

function synth(context?: Record<string, string>): Template {
  const app = new App({ context });
  const stack = new ArchimateStack(app, 'archimate-demo', { config: loadConfig(app) });
  return Template.fromStack(stack);
}

const template = synth();

describe('Cognito', () => {
  it('User Pool은 1개, 이름은 resourceName 규칙', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'archimate-demo-cognito-users',
    });
  });

  it('User Pool 삭제 정책은 DESTROY(Delete)다', () => {
    const pools = Object.values(template.findResources('AWS::Cognito::UserPool'));
    expect(pools).toHaveLength(1);
    expect(pools[0].DeletionPolicy).toBe('Delete');
    expect(pools[0].UpdateReplacePolicy).toBe('Delete');
  });

  it('앱 클라이언트는 1개이고 client secret이 없다', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'archimate-demo-cognito-web',
      GenerateSecret: false,
    });
  });

  it('User Pool에 태그 3종이 붙는다', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTags: Match.objectLike({
        Project: 'ArchiMate',
        Environment: 'demo',
        Owner: 'infra',
      }),
    });
  });

  it('User Pool ID와 Client ID를 출력값으로 내보낸다', () => {
    const outputs = template.toJSON().Outputs;
    expect(Object.keys(outputs).sort()).toEqual(['userPoolClientId', 'userPoolId']);
    expect(outputs.userPoolId.Value).toEqual({ Ref: expect.stringMatching(/^AuthUserPool/) });
    expect(outputs.userPoolClientId.Value).toEqual({ Ref: expect.stringMatching(/^AuthUserPoolClient/) });
  });

  it('스테이지를 바꾸면 이름이 따라간다', () => {
    synth({ stage: 'test' }).hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'archimate-test-cognito-users',
    });
  });
});
