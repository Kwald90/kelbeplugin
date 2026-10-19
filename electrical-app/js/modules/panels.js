// Panel schedules — placeholder until the module is built.
export default {
  id: 'panels',
  title: 'Panel schedules',
  icon: 'panel',
  group: 'field',
  perm: 'panels',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Panel schedules' }, ui.empty({ icon: 'panel', title: 'Coming soon' })));
  },
};
