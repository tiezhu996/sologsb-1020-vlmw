import { component$, useSignal, useVisibleTask$ } from '@builder.io/qwik';
import ArchiveDesk from './desks/ArchiveDesk';
import ReconDesk from './recon/ReconDesk';

type DeskMode = 'recon' | 'archive';
const MODE_KEY = 'sologsb-1020-desk-mode';

export default component$(() => {
  const mode = useSignal<DeskMode>('recon');

  useVisibleTask$(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'archive' || saved === 'recon') mode.value = saved;
  });

  const switchMode = (next: DeskMode) => {
    mode.value = next;
    try { localStorage.setItem(MODE_KEY, next); } catch { /* 离线隐私模式下忽略 */ }
  };

  return (
    <>
      {mode.value === 'recon' ? <ReconDesk /> : <ArchiveDesk />}
      <nav class="desk-switcher" aria-label="工作台切换">
        <button class={mode.value === 'recon' ? 'active' : ''} onClick$={() => switchMode('recon')}>拓片版本比对台</button>
        <button class={mode.value === 'archive' ? 'active' : ''} onClick$={() => switchMode('archive')}>档案元数据核对台</button>
      </nav>
    </>
  );
});
