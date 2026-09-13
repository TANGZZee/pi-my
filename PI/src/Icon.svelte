<script lang="ts">
  export let name: keyof typeof paths
  export let size = 16
  export let strokeWidth = 1.75

  const paths = {
    activity: 'M3 12h4l3-8 4 16 3-8h4',
    check: 'M20 6 9 17l-5-5',
    'chevron-down': 'm6 9 6 6 6-6',
    'chevron-right': 'm9 6 6 6-6 6',
    chat: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 6v6l4 2',
    copy: 'M8 8h11v11H8z M5 16H4V4h12v1',
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    fork: 'M6 3v12 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 9a9 9 0 0 1-9 9',
    git: 'M6 3v12 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 9a9 9 0 0 1-9 9',
    home: 'M3 10.5 12 3l9 7.5 M5 9.5V21h14V9.5',
    minus: 'M5 12h14',
    plus: 'M12 5v14 M5 12h14',
    refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8 M21 3v5h-5',
    search: 'M21 21l-4.3-4.3 M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
    send: 'M12 19V5 M6 11l6-6 6 6',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M19.4 15a7.9 7.9 0 0 0 .1-1 7.9 7.9 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a8 8 0 0 0-1.7-1L15 4h-4l-.3 2.6a8 8 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 13a7.9 7.9 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 1.7 1L11 22h4l.3-2.6a8 8 0 0 0 1.7-1l2.4 1 2-3.4z',
    square: 'M5 5h14v14H5z',
    terminal: 'M4 17l6-5-6-5 M12 19h8',
    todo: 'M3 6h11 M3 12h11 M3 18h11 M17 5l2 2 4-4',
    more: 'M5 12h.01 M12 12h.01 M19 12h.01',
    paperclip: 'M21.4 11.05 12.3 20a5 5 0 0 1-7.1-7.1l9-9a3.5 3.5 0 1 1 5 5l-9 9a2 2 0 0 1-2.9-2.9l8-8',
    play: 'M7 5l12 7-12 7z',
    x: 'M18 6 6 18 M6 6l12 12',
  }
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={paths[name]} />
</svg>

<style>
  svg { display: block; flex: none; }
</style>
