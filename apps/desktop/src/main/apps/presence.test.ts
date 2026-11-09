import { describe, expect, it } from 'vitest';
import { appPresence, appTokens, matchesApp, type WindowInfo } from './presence';

const writer = { name: 'LibreOffice Writer', kind: 'native' as const };
const win = (
  id: number,
  owner: string,
  title: string,
  extra: Partial<WindowInfo> = {},
): WindowInfo => ({
  id,
  owner,
  title,
  processId: id * 10,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  ...extra,
});
const notOwn = () => false;

describe('appTokens', () => {
  it('keeps meaningful words, brand first', () => {
    expect(appTokens('LibreOffice Writer')).toEqual(['libreoffice', 'writer']);
    expect(appTokens('SAP GUI for Windows')).toEqual(['sap', 'gui', 'windows']);
  });
});

describe('matchesApp', () => {
  it('matches a Writer document window (Windows-style title)', () => {
    expect(matchesApp(writer, win(1, 'soffice.bin', 'Untitled 1 - LibreOffice Writer'))).toBe(true);
  });
  it('matches by owner + title words (macOS-style)', () => {
    expect(matchesApp(writer, win(1, 'LibreOffice', 'Untitled 1 — Writer'))).toBe(true);
  });
  it('matches a macOS document window whose title has no app name', () => {
    expect(
      matchesApp(
        writer,
        win(1, 'LibreOffice', 'Untitled 1', { bundleId: 'org.libreoffice.script' }),
      ),
    ).toBe(true);
  });
  it('does not match the LibreOffice Start Center', () => {
    expect(matchesApp(writer, win(1, 'LibreOffice', 'LibreOffice'))).toBe(false);
  });
});

describe('appPresence', () => {
  it('front: Writer is the frontmost non-Qhint window', () => {
    const p = appPresence(
      writer,
      [win(1, 'LibreOffice', 'Untitled 1 - LibreOffice Writer'), win(2, 'Finder', 'Desktop')],
      notOwn,
    );
    expect(p.state).toBe('front');
  });

  it('ignores Qhint’s own windows when deciding what is in front', () => {
    const own = (w: WindowInfo) => w.owner === 'Qhint';
    const p = appPresence(
      writer,
      [win(9, 'Qhint', 'Qhint step'), win(1, 'LibreOffice', 'Untitled 1 - LibreOffice Writer')],
      own,
    );
    expect(p.state).toBe('front');
  });

  it('front: a floating screen-sharing bar on top does not hide the active app', () => {
    const bar = win(3, 'Google Chrome', 'meet.google.com is sharing your screen.', {
      bounds: { x: 0, y: 0, width: 420, height: 60 },
    });
    const windows = [bar, win(1, 'LibreOffice', 'Untitled 1 - LibreOffice Writer')];
    expect(appPresence(writer, windows, notOwn, 10).state).toBe('front');
    // Chrome really active: Writer is behind.
    expect(appPresence(writer, windows, notOwn, 30).state).toBe('behind');
  });

  it('behind: another app is in front', () => {
    const p = appPresence(
      writer,
      [win(2, 'Google Chrome', 'Inbox'), win(1, 'LibreOffice', 'Untitled 1 - LibreOffice Writer')],
      notOwn,
    );
    expect(p).toMatchObject({ state: 'behind', window: { id: 1 } });
  });

  it('front: an open menu of the same app (empty-title window on top) still counts as front', () => {
    const menu = win(5, 'LibreOffice', '', {
      processId: 10,
      bounds: { x: 0, y: 0, width: 200, height: 300 },
    });
    const doc = win(1, 'LibreOffice', 'Untitled 1', { processId: 10 });
    expect(appPresence(writer, [menu, doc], notOwn).state).toBe('front');
  });

  it('front: a tiny menu window of the same app on top still counts', () => {
    const tiny = win(5, 'LibreOffice', '', {
      processId: 10,
      bounds: { x: 0, y: 0, width: 20, height: 20 },
    });
    const doc = win(1, 'LibreOffice', 'Untitled 1', { processId: 10 });
    expect(appPresence(writer, [tiny, doc], notOwn).state).toBe('front');
  });

  it('partial: only the LibreOffice Start Center is open', () => {
    expect(appPresence(writer, [win(1, 'LibreOffice', 'LibreOffice')], notOwn).state).toBe(
      'partial',
    );
  });

  it('front: a macOS Writer document titled only "Untitled 1"', () => {
    expect(appPresence(writer, [win(1, 'LibreOffice', 'Untitled 1')], notOwn).state).toBe('front');
  });

  it('missing: not running at all', () => {
    expect(appPresence(writer, [win(2, 'Finder', 'Desktop')], notOwn).state).toBe('missing');
  });

  it('ignores tiny helper windows', () => {
    const tiny = win(1, 'LibreOffice', 'Untitled 1 - LibreOffice Writer', {
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(appPresence(writer, [tiny], notOwn).state).toBe('missing');
  });
});

describe('web apps', () => {
  const moodle = { name: 'Moodle (web)', kind: 'web' as const };
  const chrome = (title: string, pid = 50) => win(7, 'Google Chrome', title, { processId: pid });

  it('a browser in front counts, even when the page title lacks the site name', () => {
    expect(appPresence(moodle, [chrome('Course: History 101')], notOwn).state).toBe('front');
  });

  it('a browser behind another app is "behind"', () => {
    const term = win(1, 'Terminal', 'zsh', { processId: 9 });
    expect(appPresence(moodle, [term, chrome('Dashboard')], notOwn).state).toBe('behind');
  });

  it('no browser at all is "missing"', () => {
    expect(appPresence(moodle, [win(1, 'Terminal', 'zsh')], notOwn).state).toBe('missing');
  });

  it('a desktop app whose name merely contains a browser name is still a desktop app', () => {
    const research = { name: 'Research Tool', kind: 'native' as const };
    expect(appPresence(research, [chrome('Research Tool docs')], notOwn).state).toBe('missing');
  });

  it('desktop apps are not satisfied by a browser', () => {
    const writer = { name: 'LibreOffice Writer', kind: 'native' as const };
    expect(appPresence(writer, [chrome('LibreOffice download')], notOwn).state).not.toBe('front');
  });
});
