/**
 * Admin Users JavaScript
 *
 * @package Kelbe_Project_Tracker
 */

(function($) {
    'use strict';
    
    $(document).ready(function() {
        
        // Bulk assign form submission
        $('#kpt-bulk-assign-form').on('submit', function(e) {
            e.preventDefault();
            
            var users = $('#users').val();
            var projects = $('#projects').val();
            var role = $('#role').val();
            
            if (!users || users.length === 0) {
                alert('Please select at least one user.');
                return;
            }
            
            if (!projects || projects.length === 0) {
                alert('Please select at least one project.');
                return;
            }
            
            var $submitBtn = $(this).find('[type="submit"]');
            $submitBtn.prop('disabled', true);
            
            $.ajax({
                url: kptUsers.ajax_url,
                type: 'POST',
                data: {
                    action: 'kpt_bulk_assign_users',
                    nonce: kptUsers.nonce,
                    users: users,
                    projects: projects,
                    role: role
                },
                success: function(response) {
                    if (response.success) {
                        alert(response.data.message);
                        window.location.href = window.location.href.split('?')[0] + '?page=kpt-user-management';
                    } else {
                        alert(response.data.message);
                        $submitBtn.prop('disabled', false);
                    }
                },
                error: function() {
                    alert('Error assigning users.');
                    $submitBtn.prop('disabled', false);
                }
            });
        });
        
        // Capabilities form submission
        $('#kpt-capabilities-form').on('submit', function(e) {
            e.preventDefault();
            
            var $submitBtn = $(this).find('[type="submit"]');
            $submitBtn.prop('disabled', true);
            
            $.ajax({
                url: kptUsers.ajax_url,
                type: 'POST',
                data: {
                    action: 'kpt_update_user_capabilities',
                    nonce: kptUsers.nonce,
                    capabilities: $(this).serialize()
                },
                success: function(response) {
                    if (response.success) {
                        alert(response.data.message);
                    } else {
                        alert(response.data.message);
                    }
                    $submitBtn.prop('disabled', false);
                },
                error: function() {
                    alert('Error updating capabilities.');
                    $submitBtn.prop('disabled', false);
                }
            });
        });
    });
    
})(jQuery);
