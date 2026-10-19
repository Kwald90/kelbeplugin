// Calculators — placeholder until the module is built.
export default {
  id: 'calcs',
  title: 'Calculators',
  icon: 'calculator',
  group: 'field',
  perm: 'calcs',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Calculators' }, ui.empty({ icon: 'calculator', title: 'Coming soon' })));
  },
};
