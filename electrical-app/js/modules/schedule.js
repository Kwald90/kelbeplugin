// Schedule — placeholder until the module is built.
export default {
  id: 'schedule',
  title: 'Schedule',
  icon: 'calendar',
  group: 'work',
  perm: 'schedule',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Schedule' }, ui.empty({ icon: 'calendar', title: 'Coming soon' })));
  },
};
