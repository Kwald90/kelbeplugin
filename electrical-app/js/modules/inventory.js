// Inventory — placeholder until the module is built.
export default {
  id: 'inventory',
  title: 'Inventory',
  icon: 'box',
  group: 'money',
  perm: 'inventory',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Inventory' }, ui.empty({ icon: 'box', title: 'Coming soon' })));
  },
};
