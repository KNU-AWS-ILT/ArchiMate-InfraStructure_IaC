module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  // 테스트 전에 CDK 자산 복사를 끈다. (test/jest.setup.ts 참고)
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  // 테스트 하나의 제한 시간(기본 5초). CI 실행기는 느릴 수 있어 넉넉히 둔다.
  testTimeout: 30000,
};
