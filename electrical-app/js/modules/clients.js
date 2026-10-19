// Clients — placeholder until the module is built.
export default {
  id: 'clients',
  title: 'Clients',
  icon: 'users',
  group: 'sales',
  perm: 'clients',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Clients' }, ui.empty({ icon: 'users', title: 'Coming soon' })));
  },
};
