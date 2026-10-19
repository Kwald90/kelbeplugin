// Time clock — placeholder until the module is built.
export default {
  id: 'time',
  title: 'Time clock',
  icon: 'clock',
  group: 'people',
  perm: 'time',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Time clock' }, ui.empty({ icon: 'clock', title: 'Coming soon' })));
  },
};
