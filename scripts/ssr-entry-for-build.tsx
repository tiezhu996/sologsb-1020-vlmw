import { renderToString } from '@builder.io/qwik/server';
import App from '../src/App';
import manifestJson from '../dist-smoke/client/q-manifest.json';

export function renderSmoke() {
  return renderToString(<App />, {
    containerTagName: 'div',
    manifest: manifestJson,
    qwikLoader: { include: 'never' }
  });
}
