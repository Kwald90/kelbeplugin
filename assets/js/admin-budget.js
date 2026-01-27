/**
 * Admin Budget JavaScript
 *
 * @package Kelbe_Project_Tracker
 */

(function($) {
    'use strict';
    
    $(document).ready(function() {
        
        // Export to CSV
        $('#export-budget-csv').on('click', function(e) {
            e.preventDefault();
            
            var exportUrl = kptBudget.ajax_url + '?action=kpt_export_budget_csv&nonce=' + kptBudget.nonce;
            window.location.href = exportUrl;
        });
        
        // Initialize datepicker if available
        if ($.fn.datepicker) {
            $('.kpt-datepicker').datepicker({
                dateFormat: 'yy-mm-dd'
            });
        }
    });
    
})(jQuery);
