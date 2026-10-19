// Dashboard — placeholder until the module is built.
export default {
  id: 'dashboard',
  title: 'Dashboard',
  icon: 'home',
  group: 'home',
  perm: 'dashboard',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Dashboard' }, ui.empty({ icon: 'home', title: 'Coming soon' })));
  },
};
