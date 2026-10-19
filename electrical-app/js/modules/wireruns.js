// Wire runs: named, saved runs measured with an AR tape, traced on a drawing or
// typed in, with drops and box allowances, totals per conductor and a PDF report.
export default {
  id: 'wireruns',
  title: 'Wire runs',
  icon: 'ruler',
  group: 'work',
  perm: 'drawings',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Wire runs' },
      ui.empty({ icon: 'ruler', title: 'Coming soon', text: 'Measure a run along a wall or conduit, save it with a name and export it as a PDF.' })));
  },
};
