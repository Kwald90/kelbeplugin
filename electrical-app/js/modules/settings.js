// Settings — placeholder until the module is built.
export default {
  id: 'settings',
  title: 'Settings',
  icon: 'settings',
  group: 'admin',
  perm: 'settings',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Settings' }, ui.empty({ icon: 'settings', title: 'Coming soon' })));
  },
};
