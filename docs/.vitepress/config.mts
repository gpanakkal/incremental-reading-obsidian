import { defineConfig } from 'vitepress';

const pluginRepo = 'https://github.com/gpanakkal/incremental-reading-obsidian';

export default defineConfig({
  title: 'Incremental Reading',
  description:
    'Documentation for the Incremental Reading plugin for Obsidian: learn from texts with spaced repetition and a priority queue.',
  lang: 'en-US',
  // Project pages are served from /<repo>/. Change to '/' for a custom domain.
  base: '/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    [
      'link',
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
      },
    ],
  ],

  themeConfig: {
    logo: '/favicon.svg',

    nav: [
      { text: 'Guide', link: '/quick-start', activeMatch: '^/(quick-start|features|guide/|troubleshooting)' },
      { text: 'Reference', link: '/reference/commands', activeMatch: '^/reference/' },
      { text: 'Resources', link: '/resources' },
    ],

    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Quick start', link: '/quick-start' },
          { text: 'Feature overview', link: '/features' },
        ],
      },
      {
        text: 'Using the plugin',
        items: [
          { text: 'Importing material', link: '/guide/importing' },
          { text: 'Review sessions', link: '/guide/review-sessions' },
          { text: 'Scheduling', link: '/guide/scheduling' },
          { text: 'Outside review', link: '/guide/outside-review' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Commands and hotkeys', link: '/reference/commands' },
          { text: 'Action bar', link: '/reference/action-bar' },
          { text: 'Settings', link: '/reference/settings' },
          { text: 'Glossary', link: '/reference/glossary' },
          { text: 'Plugin data', link: '/reference/plugin-data' },
        ],
      },
      {
        text: 'More',
        items: [{ text: 'External resources', link: '/resources' }],
      },
    ],

    socialLinks: [{ icon: 'github', link: pluginRepo }],

    editLink: {
      pattern: `${pluginRepo}/edit/main/docs/:path`,
      text: 'Suggest an edit to this page',
    },

    outline: [2, 3],

    search: {
      provider: 'local',
      options: {
        detailedView: true,
        miniSearch: {
          // MiniSearch indexes each heading section as its own result, so a
          // match in a heading ("titles") or the section's own title ranks
          // above a match in body text. These are VitePress's defaults, kept
          // here as the place to tune them.
          searchOptions: {
            fuzzy: 0.2, // allowed typos, as a fraction of the term's length
            prefix: true, // match partial words while typing
            boost: { title: 4, text: 2, titles: 1 },
          },
        },
      },
    },

    footer: {
      message: `Released under the <a href="${pluginRepo}/blob/main/LICENSE">AGPL-3.0</a> license.`,
    },
  },
});
