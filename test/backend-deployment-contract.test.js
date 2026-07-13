const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Docker image builds local frontend assets and records source provenance', () => {
    const dockerfile = read('Dockerfile');
    assert.match(dockerfile, /RUN npm run build:frontend/);
    assert.match(dockerfile, /COPY --from=builder \/app\/public \.\/public/);
    assert.match(dockerfile, /ARG VCS_REF=/);
    assert.match(dockerfile, /ARG APP_VERSION=/);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{VCS_REF\}"/);
    assert.match(dockerfile, /org\.opencontainers\.image\.version="\$\{APP_VERSION\}"/);
    assert.match(dockerfile, /APP_REVISION=\$\{VCS_REF\}/);
});

test('compose templates keep trust proxy safe while supporting explicit bind choice', () => {
    for (const file of ['docker-compose.yml', 'deploy/docker-compose.yml']) {
        const compose = read(file);
        assert.match(compose, /TRUST_PROXY[^\n]*:-false/);
        assert.match(compose, /TEST_INSTANCE_ID/);
    }
    assert.match(read('deploy/docker-compose.yml'), /HOST_BIND:-0\.0\.0\.0/);
    assert.match(read('deploy/.env.example'), /HOST_BIND=0\.0\.0\.0/);
});

test('offline packaging derives the version and uses an explicit IMAGE_TAG manifest', () => {
    const shellBuild = read('deploy/build-and-pack.sh');
    const batchBuild = read('deploy/build-and-pack.bat');
    const importer = read('deploy/import-load.sh');
    assert.match(shellBuild, /require\('\.\/package\.json'\)\.version/);
    assert.match(shellBuild, /git rev-parse --short=7 HEAD/);
    assert.match(batchBuild, /require\('\.\/package\.json'\)\.version/);
    assert.match(batchBuild, /git rev-parse --short\^=7 HEAD/);
    assert.match(importer, /< IMAGE_TAG/);
    for (const source of [shellBuild, batchBuild, importer, read('deploy/README-1PANEL.md')]) {
        assert.doesNotMatch(source, /qywx-notifier-plus-1\.0\.0/);
    }
});

test('deployment guide distinguishes HTTPS proxy and direct access modes', () => {
    const guide = read('deploy/README-1PANEL.md');
    assert.match(guide, /HOST_BIND=127\.0\.0\.1/);
    assert.match(guide, /TRUST_PROXY=loopback/);
    assert.match(guide, /HOST_BIND=0\.0\.0\.0/);
    assert.match(guide, /TRUST_PROXY=false/);
    assert.match(guide, /不要通过公网明文 HTTP 登录/);
});

