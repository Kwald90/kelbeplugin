// Security audit — placeholder until the module is built.
export default {
  id: 'security',
  title: 'Security audit',
  icon: 'lock',
  group: 'admin',
  perm: 'security',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Security audit' }, ui.empty({ icon: 'lock', title: 'Coming soon' })));
  },
};
