// Jobs — placeholder until the module is built.
export default {
  id: 'jobs',
  title: 'Jobs',
  icon: 'briefcase',
  group: 'work',
  perm: 'jobs',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Jobs' }, ui.empty({ icon: 'briefcase', title: 'Coming soon' })));
  },
};
