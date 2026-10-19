// Employees — placeholder until the module is built.
export default {
  id: 'employees',
  title: 'Employees',
  icon: 'id-card',
  group: 'people',
  perm: 'employees',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Employees' }, ui.empty({ icon: 'id-card', title: 'Coming soon' })));
  },
};
