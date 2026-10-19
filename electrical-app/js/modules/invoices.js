// Invoices — placeholder until the module is built.
export default {
  id: 'invoices',
  title: 'Invoices',
  icon: 'receipt',
  group: 'money',
  perm: 'invoices',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Invoices' }, ui.empty({ icon: 'receipt', title: 'Coming soon' })));
  },
};
