export const ANALYTICS_LENSES = [
  {
    href: '/flows',
    title: 'Потоци',
    desc: 'Накъде текат парите: от възложители към сектори и изпълнители.',
  },
  {
    href: '/map',
    title: 'Карта',
    desc: 'Къде по области се концентрират разходите за обществени поръчки.',
  },
  {
    href: '/trends',
    title: 'Тренд',
    desc: 'Как се движат разходите във времето по месеци и години.',
  },
  {
    href: '/competition',
    title: 'Конкуренция',
    desc: 'Къде има висок дял „една оферта“ и концентрация на доставчици.',
  },
  {
    href: '/overruns',
    title: 'Раздуване',
    desc: 'Кои договори, институции и сектори се раздуват най-много след сключване — и тенденцията във времето.',
  },
  {
    href: '/compare',
    title: 'Сравнение',
    desc: 'Две институции или две компании, едно до друго по общите показатели.',
  },
] as const;

export const ANALYTICS_NAV_PATHS = [
  '/analytics',
  ...ANALYTICS_LENSES.map((lens) => lens.href),
  '/network',
] as const;
